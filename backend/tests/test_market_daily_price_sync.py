"""日线抓取 + 历史回补服务单测（mock 网络层，不触真实 akshare/腾讯）。

守护决策 A9（双防线：交易日历校验主 + 返回日期比对备）/ A15（回补常量）/
附录 A.11（burst≈10 + 冷却 60-120s + 指数退避 60/120/300s）。
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.date_utils import today_app_tz
from app.models import (
    DividendYieldSettings,
    MarketSecurityDailyPrice,
    MarketTradeCalendar,
    QuoteInterface,
    SecuritiesDataProvider,
    Security,
    SecurityDividend,
)
from app.models.enums import DividendStatus, QuoteProviderAccessMethod, ReportPeriodType, SecurityType
from app.models.interface_category import InterfaceCategory
from app.services.market_data_sync import (
    QUOTE_CAT_ID,
    MarketDataSyncService,
    _normalize_master_code,
    infer_exchange,
)
from app.services.market_daily_price_sync import (
    MarketDailyPriceSyncService,
    backfill_historical,
    _BACKFILL_BACKOFFS,
    _BACKFILL_BURST,
    _BACKFILL_COOLDOWN_MAX,
    _BACKFILL_COOLDOWN_MIN,
)


def _uid() -> str:
    return str(uuid.uuid4())


# ───────────────────────── 回补常量（决策 A15 / 附录 A.11） ─────────────────────────
def test_backfill_rate_constants():
    """守护附录 A.11 / 决策 A15：burst≈10、冷却 60-120s、退避 60/120/300s。"""
    assert _BACKFILL_BURST == 10
    assert _BACKFILL_COOLDOWN_MIN <= _BACKFILL_COOLDOWN_MAX
    assert _BACKFILL_COOLDOWN_MIN == 60.0
    assert _BACKFILL_COOLDOWN_MAX == 120.0
    assert _BACKFILL_BACKOFFS == (60, 120, 300)  # 指数退避，用尽即放弃该证券


async def _add_master(session, code="600000"):
    norm = _normalize_master_code(code, infer_exchange(code))
    m = Security(id=_uid(), code=norm, name="浦发银行", asset_class=SecurityType.STOCK)
    session.add(m)
    await session.flush()
    return m


# ───────────────────────── 双防线之防线一（决策 A9 主） ─────────────────────────
@pytest.mark.asyncio
async def test_daily_close_fetch_non_trade_day_skips(session):
    """守护决策 A9：非交易日历有值且不含今日 → 整批跳过不抓取。"""
    session.add(MarketTradeCalendar(trade_date=date(2020, 1, 1)))  # 日历非空但非今日
    await session.commit()
    svc = MarketDailyPriceSyncService(session)
    result = await svc.daily_close_fetch({})
    assert "非交易日" in result


# ───────────────────────── 双防线之防线二（决策 A9 备） ─────────────────────────
@pytest.mark.asyncio
async def test_daily_close_fetch_return_date_mismatch_skips_batch(session, monkeypatch):
    """守护决策 A9 / §6.2：返回日期 ≠ 今日 → 整批跳过不写入（节假日/停牌防污）。"""
    today = today_app_tz()
    session.add(MarketTradeCalendar(trade_date=today))  # 防线一通过
    m = await _add_master(session)
    session.add(
        SecurityDividend(master_id=m.id, report_year=today.year, report_quarter=1,
                         period_type=ReportPeriodType.ANNUAL,
                         cash_per_share=Decimal("1.0"), status=DividendStatus.PAID)
    )
    provider = SecuritiesDataProvider(
        id=_uid(), name="腾讯", access_method=QuoteProviderAccessMethod.HTTPS,
        config={"base_url": "https://qt.gtimg.cn"}, enabled=True,
    )
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID, name="腾讯",
        endpoint="/q", http_method="GET", enabled=True, priority=1,
        resp_code_field="代码", resp_price_field="收盘",
        response_parse={"resp_date_field": "日期", "max_codes_per_request": 800},
        params={},
    )
    session.add(provider)
    await session.flush()  # 提供方先落库，接口 provider_id 外键才有归属
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    session.add(itf)
    await session.flush()
    session.add(DividendYieldSettings(green_threshold=Decimal("0.05"),
                                      red_threshold=Decimal("0.03"),
                                      price_source_interface_id=itf.id))
    await session.commit()

    svc = MarketDailyPriceSyncService(session)

    async def _fake_raw(itf_obj, params, codes):
        return [{"代码": "600000", "收盘": "10.5", "日期": "2020-01-01"}]  # 上一交易日

    svc._mds._call_interface_raw = _fake_raw
    result = await svc.daily_close_fetch({})

    # 该批次被整批丢弃，未写入任何日线行
    rows = (await session.execute(select(MarketSecurityDailyPrice))).scalars().all()
    assert rows == []
    assert "失败批次 1" in result
    assert "成功行 0" in result


@pytest.mark.asyncio
async def test_daily_close_fetch_writes_on_matching_date(session):
    """守护 §6.2：返回日期 == 今日 → 幂等写入当日收盘价并重算派生快照。"""
    today = today_app_tz()
    session.add(MarketTradeCalendar(trade_date=today))
    m = await _add_master(session)
    session.add(
        SecurityDividend(master_id=m.id, report_year=today.year, report_quarter=4,
                         period_type=ReportPeriodType.ANNUAL,
                         cash_per_share=Decimal("1.0"), status=DividendStatus.PAID)
    )
    provider = SecuritiesDataProvider(
        id=_uid(), name="腾讯", access_method=QuoteProviderAccessMethod.HTTPS,
        config={"base_url": "https://qt.gtimg.cn"}, enabled=True,
    )
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID, name="腾讯",
        endpoint="/q", http_method="GET", enabled=True, priority=1,
        resp_code_field="代码", resp_price_field="收盘",
        response_parse={"resp_date_field": "日期", "max_codes_per_request": 800},
        params={},
    )
    session.add(provider)
    await session.flush()  # 提供方先落库，接口 provider_id 外键才有归属
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    session.add(itf)
    await session.flush()
    session.add(DividendYieldSettings(green_threshold=Decimal("0.05"),
                                      red_threshold=Decimal("0.03"),
                                      price_source_interface_id=itf.id))
    await session.commit()

    svc = MarketDailyPriceSyncService(session)

    async def _fake_raw(itf_obj, params, codes):
        return [{"代码": "600000", "收盘": "12.34", "日期": today.strftime("%Y-%m-%d")}]

    svc._mds._call_interface_raw = _fake_raw
    result = await svc.daily_close_fetch({})

    rows = (await session.execute(select(MarketSecurityDailyPrice))).scalars().all()
    assert len(rows) == 1
    assert rows[0].trade_date == today
    assert rows[0].close == Decimal("12.34")
    assert "成功行 1" in result

@pytest.mark.asyncio
async def test_daily_close_fetch_mixed_dates_batch_rejected(session, monkeypatch):
    """守护 P2-2（§6.2）：批次混有停牌股（返回上一交易日日期）→ 整批跳过。

    旧实现「today in dates（任一命中即放行）」拦不住停牌脏价；收紧为 dates != {today} 后，
    本测试构成真回归守护。
    """
    today = today_app_tz()
    session.add(MarketTradeCalendar(trade_date=today))
    m1 = await _add_master(session, code="600001")
    m2 = await _add_master(session, code="600002")
    for m in (m1, m2):
        session.add(
            SecurityDividend(master_id=m.id, report_year=today.year, report_quarter=1,
                             period_type=ReportPeriodType.ANNUAL,
                             cash_per_share=Decimal("1.0"), status=DividendStatus.PAID)
        )
    provider = SecuritiesDataProvider(
        id=_uid(), name="腾讯", access_method=QuoteProviderAccessMethod.HTTPS,
        config={"base_url": "https://qt.gtimg.cn"}, enabled=True,
    )
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID, name="腾讯",
        endpoint="/q", http_method="GET", enabled=True, priority=1,
        resp_code_field="代码", resp_price_field="收盘",
        response_parse={"resp_date_field": "日期", "max_codes_per_request": 800},
        params={},
    )
    session.add(provider)
    await session.flush()
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    session.add(itf)
    await session.flush()
    session.add(DividendYieldSettings(green_threshold=Decimal("0.05"),
                                      red_threshold=Decimal("0.03"),
                                      price_source_interface_id=itf.id))
    await session.commit()

    svc = MarketDailyPriceSyncService(session)

    async def _fake_raw(itf_obj, params, codes):
        # 混合日期：一只正常返回今日、一只停牌返回上一交易日 → 整批必须被拦
        return [
            {"代码": "600001", "收盘": "10.5", "日期": today.strftime("%Y-%m-%d")},
            {"代码": "600002", "收盘": "9.9", "日期": "2020-01-01"},
        ]

    svc._mds._call_interface_raw = _fake_raw
    result = await svc.daily_close_fetch({})

    rows = (await session.execute(select(MarketSecurityDailyPrice))).scalars().all()
    assert rows == []  # 混合日期批次整批跳过，停牌脏价不得写入
    assert "失败批次 1" in result


# ───────────────────────── 回补 symbol 剥离（P2-2，§6.2） ─────────────────────────
@pytest.mark.asyncio
async def test_backfill_strips_exchange_prefix_from_symbol(session, monkeypatch):
    r"""守护 P2-2：历史回补传 akshare stock_zh_a_hist 的 symbol 须为纯数字（如 600000）。

    Security.code 带交易所前缀（sh600000），旧实现直接透传 sec.code 会导致上游按前缀码查无结果；
    修复后须在组装 params 时剥离非数字字符（对照 notice_scan 的 re.sub(r"\D","",code)）。
    """
    # _add_master 经 _normalize_master_code 产出的 code 带 sh/sz 前缀，与线上一致
    m = await _add_master(session, code="600000")
    assert m.code == "sh600000"  # 前置：主数据确实带前缀

    provider = SecuritiesDataProvider(
        id=_uid(), name="akshare", access_method=QuoteProviderAccessMethod.SDK,
        config={}, enabled=True,
    )
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID, name="东财历史",
        endpoint="stock_zh_a_hist", http_method="GET", enabled=True, priority=1,
        resp_code_field="代码", resp_price_field="收盘",
        response_parse={}, params={},
    )
    session.add(provider)
    await session.flush()  # 提供方先落库，接口 provider_id 外键才有归属
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    session.add(itf)
    await session.commit()

    captured: dict = {}

    async def _fake_sdk(self, itf_obj, params, codes):
        # 类级 monkeypatch → mds._fetch_sdk_raw(itf, params, codes=None) 绑定实例后
        # 依次填充 (self, itf_obj, params, codes)，缺 self 会与关键字 codes 冲突
        captured.update(params)  # 捕获实际传给 akshare 的入参
        # 返回中文列（_COL_HIST_DATE/_COL_HIST_CLOSE），让 _upsert_hist_rows 能落库
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    # 退避常量归零：mock 失败时也不真实 sleep 60/120/300s（保持测试秒级）
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,))

    result = await backfill_historical(session, itf, [m.id], date(2024, 1, 1))

    # 关键断言：symbol 必须是纯数字，交易所前缀已被剥离
    assert captured.get("symbol") == "600000"
    assert "历史回补完成" in result


# ───────────────────────── 回补断点判定（P1-3，§6.2/A15） ─────────────────────────
@pytest.mark.asyncio
async def test_backfill_gap_security_not_skipped(session, monkeypatch):
    """守护 P1-3：断点判定须用最早 trade_date——只有近期数据（中间有历史空洞）的
    证券不得被跳过；起点已覆盖的证券才跳过。旧实现 max(trade_date) >= start_date
    会把空洞证券全部误跳过。"""
    m_done = await _add_master(session, code="600001")
    m_gap = await _add_master(session, code="600002")
    # m_done：起点已覆盖（最早 2023-01-01 ≤ start）→ 跳过
    session.add(MarketSecurityDailyPrice(
        master_id=m_done.id, trade_date=date(2023, 1, 1), close=Decimal("10"),
    ))
    # m_gap：只有近期数据（最早 2025-01-01 > start）→ 历史空洞，须回补
    session.add(MarketSecurityDailyPrice(
        master_id=m_gap.id, trade_date=date(2025, 1, 1), close=Decimal("10"),
    ))
    provider = SecuritiesDataProvider(
        id=_uid(), name="akshare", access_method=QuoteProviderAccessMethod.SDK,
        config={}, enabled=True,
    )
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID, name="东财历史",
        endpoint="stock_zh_a_hist", http_method="GET", enabled=True, priority=1,
        resp_code_field="代码", resp_price_field="收盘", response_parse={}, params={},
    )
    session.add(provider)
    await session.flush()
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    session.add(itf)
    await session.commit()

    fetched: list[str] = []

    async def _fake_sdk(self, itf_obj, params, codes):
        fetched.append(params["symbol"])
        return [{"日期": "2024-06-03", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,)
    )
    # 批间冷却归零，保持测试秒级
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MIN", 0
    )
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MAX", 0
    )

    result = await backfill_historical(
        session, itf, [m_done.id, m_gap.id], date(2024, 1, 1)
    )

    assert fetched == ["600002"]  # 仅空洞证券被抓取；起点已覆盖的跳过
    assert "跳过 1 只" in result and "失败 0 只" in result


# ───────────────────────── 回补生产入口（P1-3，cfg.params.backfill_start） ─────────────────────────
async def _seed_sdk_quote_source(session):
    """造 SDK 行情源 + 配置表，返回 itf（供 daily_close_fetch 回补入口测试复用）。"""
    provider = SecuritiesDataProvider(
        id=_uid(), name="akshare", access_method=QuoteProviderAccessMethod.SDK,
        config={}, enabled=True,
    )
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID, name="东财历史",
        endpoint="stock_zh_a_hist", http_method="GET", enabled=True, priority=1,
        resp_code_field="代码", resp_price_field="收盘", response_parse={}, params={},
    )
    session.add(provider)
    await session.flush()
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    session.add(itf)
    await session.flush()
    session.add(DividendYieldSettings(green_threshold=Decimal("0.05"),
                                      red_threshold=Decimal("0.03"),
                                      price_source_interface_id=itf.id))
    return itf


@pytest.mark.asyncio
async def test_daily_close_fetch_backfill_entry_non_sdk_fails_fast(session):
    """守护 P1-3：行情源非 SDK 时配置 backfill_start → fail fast 落 FAILED。"""
    import types

    today = today_app_tz()
    session.add(MarketTradeCalendar(trade_date=today))
    m = await _add_master(session)
    session.add(
        SecurityDividend(master_id=m.id, report_year=today.year, report_quarter=1,
                         period_type=ReportPeriodType.ANNUAL,
                         cash_per_share=Decimal("1.0"), status=DividendStatus.PAID)
    )
    provider = SecuritiesDataProvider(
        id=_uid(), name="腾讯", access_method=QuoteProviderAccessMethod.HTTPS,
        config={"base_url": "https://qt.gtimg.cn"}, enabled=True,
    )
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID, name="腾讯",
        endpoint="/q", http_method="GET", enabled=True, priority=1,
        resp_code_field="代码", resp_price_field="收盘",
        response_parse={"resp_date_field": "日期", "max_codes_per_request": 800},
        params={},
    )
    session.add(provider)
    await session.flush()
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    session.add(itf)
    await session.flush()
    session.add(DividendYieldSettings(green_threshold=Decimal("0.05"),
                                      red_threshold=Decimal("0.03"),
                                      price_source_interface_id=itf.id))
    await session.commit()

    svc = MarketDailyPriceSyncService(session)

    async def _fake_raw(itf_obj, params, codes):
        return [{"代码": "600000", "收盘": "10.5", "日期": today_app_tz().isoformat()}]

    svc._mds._call_interface_raw = _fake_raw
    cfg = types.SimpleNamespace(params={"backfill_start": "2023-01-01"})
    with pytest.raises(RuntimeError, match="access_method=sdk"):
        await svc.daily_close_fetch(cfg)


@pytest.mark.asyncio
async def test_daily_close_fetch_backfill_entry_runs_hist_backfill(session, monkeypatch):
    """守护 P1-3：SDK 行情源 + backfill_start → 日抓完成后执行历史回补并写入历史行。"""
    import types

    today = today_app_tz()
    session.add(MarketTradeCalendar(trade_date=today))
    m = await _add_master(session)
    session.add(
        SecurityDividend(master_id=m.id, report_year=today.year, report_quarter=1,
                         period_type=ReportPeriodType.ANNUAL,
                         cash_per_share=Decimal("1.0"), status=DividendStatus.PAID)
    )
    await _seed_sdk_quote_source(session)
    await session.commit()

    async def _fake_sdk(self, itf_obj, params, codes):
        # 日抓（codes 非空）与回补（codes=None）共用 SDK 链路，按形状区分返回
        if codes:
            return [{"代码": "600000", "收盘": "10.5"}]
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,)
    )

    svc = MarketDailyPriceSyncService(session)
    cfg = types.SimpleNamespace(params={"backfill_start": "2023-01-01"})
    result = await svc.daily_close_fetch(cfg)

    assert "历史回补完成" in result
    rows = (await session.execute(select(MarketSecurityDailyPrice))).scalars().all()
    dates = {r.trade_date for r in rows}
    assert today in dates          # 日抓正常写入当日
    assert date(2024, 1, 2) in dates  # 回补写入历史行


# ───────────────────────── 回补单只超时上界（B 修复，_BACKFILL_FETCH_TIMEOUT） ─────────────────────────
@pytest.mark.asyncio
async def test_backfill_single_fetch_timeout_marks_failed_and_proceeds(session, monkeypatch):
    """守护 B 修复：单只 _fetch_sdk_raw 卡死（永远 sleep）应被 _BACKFILL_FETCH_TIMEOUT
    兜底超时，由 except Exception 退避重试后计为失败，整轮回补不卡死。"""
    m = await _add_master(session, code="600003")
    provider = SecuritiesDataProvider(
        id=_uid(), name="akshare", access_method=QuoteProviderAccessMethod.SDK,
        config={}, enabled=True,
    )
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID, name="东财历史",
        endpoint="stock_zh_a_hist", http_method="GET", enabled=True, priority=1,
        resp_code_field="代码", resp_price_field="收盘", response_parse={}, params={},
    )
    session.add(provider)
    await session.flush()
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    session.add(itf)
    await session.commit()

    async def _fake_sdk_sleep_forever(self, itf_obj, params, codes):
        # 模拟单只请求底层 HTTP 卡死：永不返回，逼出 _BACKFILL_FETCH_TIMEOUT
        await asyncio.sleep(9999)
        return []

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk_sleep_forever)
    # 超时上界压到极小，避免测试真实等待 60s
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_FETCH_TIMEOUT", 0.05
    )
    # 退避常量归零：超时后重试不真实 sleep 60/120/300s（保持测试秒级）
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,)
    )
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MIN", 0
    )
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MAX", 0
    )

    result = await backfill_historical(session, itf, [m.id], date(2024, 1, 1))

    # 关键：超时经 except Exception 退避重试后，该证券被计为失败、整轮不卡死并正常收尾
    assert "历史回补完成" in result
    assert "失败 1 只" in result
    # 卡死的证券不应落任何历史行
    rows = (await session.execute(select(MarketSecurityDailyPrice))).scalars().all()
    assert all(r.master_id != m.id for r in rows)
