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
    run_pending_price_backfill,
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


# ───────────────────────── 回补连续失败熔断（_BACKFILL_FAILURE_BREAKER） ─────────────────────────
@pytest.mark.asyncio
async def test_backfill_failure_breaker_aborts_at_threshold(session, monkeypatch):
    """连续失败达到阈值即熔断：提前抛出 RuntimeError，且只处理了阈值只（不空转全池）。

    还原真实故障场景：数据源 push2his.eastmoney.com 对本机 IP 定向拒连，单只立即失败。
    阈值压到 3，准备 10 只待回补证券——断言第 3 只失败后即刻中止、仅处理 3 只。
    """
    masters = [await _add_master(session, code=f"600{100 + i}") for i in range(10)]
    itf = await _seed_sdk_quote_source(session)
    await session.commit()

    calls: list[str] = []

    async def _fake_sdk_always_fail(self, itf_obj, params, codes):
        calls.append(params["symbol"])  # 记录实际发请求的证券
        raise RuntimeError("数据源定向拒连（模拟 push2his.eastmoney.com 拒连）")

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk_always_fail)
    # 退避常量归零：失败立即计为失败，不真实 sleep 60/120/300s
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,)
    )
    # 阈值压到 3，便于秒级验证熔断点
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_FAILURE_BREAKER", 3
    )

    with pytest.raises(RuntimeError) as excinfo:
        await backfill_historical(
            session, itf, [m.id for m in masters], date(2024, 1, 1)
        )

    msg = str(excinfo.value)
    assert "熔断" in msg and "连续失败" in msg  # 中文消息含熔断/连续失败字样
    # 关键：只处理了 3 只（阈值），而非 10 只——证明真的提前中止、未空转全池
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_backfill_failure_counter_reset_on_success(session, monkeypatch):
    """「失败2→成功1→失败2」序列、阈值 3 时不应熔断（成功使连续失败计数清零）。

    守护：成功分支必须重置 consecutive_failures，否则会被中间一次成功「误导」触发熔断。
    """
    masters = [await _add_master(session, code=f"600{200 + i}") for i in range(5)]
    itf = await _seed_sdk_quote_source(session)
    await session.commit()

    call_idx = {"n": 0}
    # 第 0、1 只失败（cf=1,2）；第 2 只成功（清零）；第 3、4 只失败（cf=1,2）→ 最大连续 2 < 3
    success_at = {2}

    async def _fake_sdk(self, itf_obj, params, codes):
        i = call_idx["n"]
        call_idx["n"] += 1
        if i in success_at:
            return [{"日期": "2024-01-02", "收盘": "10.50"}]
        raise RuntimeError("拒连")

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,)
    )
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_FAILURE_BREAKER", 3
    )

    # 不抛 RuntimeError 即证明未误触发熔断
    result = await backfill_historical(
        session, itf, [m.id for m in masters], date(2024, 1, 1)
    )
    assert "历史回补完成" in result
    assert "失败 4 只" in result  # 0/1/3/4 共 4 只失败，均未误中止


@pytest.mark.asyncio
async def test_backfill_breaker_keeps_written_rows_resumable(session, monkeypatch):
    """熔断抛出后，此前成功写入的日线行仍保留（已 commit），可断点续跑、未回滚。

    构造：前 2 只成功写入 → 后续连续失败达阈值 3 触发熔断。断言前 2 只的日线行仍在库。
    """
    masters = [await _add_master(session, code=f"600{300 + i}") for i in range(5)]
    itf = await _seed_sdk_quote_source(session)
    await session.commit()
    # 回补过程含 rollback，会使 masters 对象属性过期；先抓取纯量 id 供断言使用
    master_ids = [m.id for m in masters]

    call_idx = {"n": 0}

    async def _fake_sdk(self, itf_obj, params, codes):
        i = call_idx["n"]
        call_idx["n"] += 1
        if i < 2:  # 前两只成功写入（各自 commit）
            return [{"日期": "2024-01-02", "收盘": "10.50"}]
        raise RuntimeError("拒连")  # 第 2 只起连续失败 → 阈值 3 触发熔断

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,)
    )
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_FAILURE_BREAKER", 3
    )

    with pytest.raises(RuntimeError):
        await backfill_historical(
            session, itf, master_ids, date(2024, 1, 1)
        )

    # 熔断前成功写入的 2 只日线行仍在库（已 commit，rollback 不回滚已提交事务）
    rows = (await session.execute(select(MarketSecurityDailyPrice))).scalars().all()
    written_masters = {r.master_id for r in rows}
    assert master_ids[0] in written_masters
    assert master_ids[1] in written_masters
    # 失败的那只不应落任何行
    assert master_ids[2] not in written_masters


# ───────────────────────── 在途回补任务（形态 A，§6.2 在途任务） ─────────────────────────
@pytest.mark.asyncio
async def test_run_pending_price_backfill_no_pending_makes_no_request(session, monkeypatch):
    """守护形态 A：无在途任务（price_backfill_start_date 为空）→ 直接返回提示、不发任何请求。"""
    await _seed_sdk_quote_source(session)  # 造 settings 行（start_date 为空）
    await session.commit()

    calls = {"n": 0}

    async def _fake_sdk(self, itf_obj, params, codes):
        calls["n"] += 1
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    msg = await run_pending_price_backfill(session)
    assert calls["n"] == 0  # 零请求
    assert "无在途" in msg  # 中文提示含「无在途」


@pytest.mark.asyncio
async def test_run_pending_price_backfill_respects_quota(session, monkeypatch):
    """守护形态 A：在途 + 有未覆盖 → 只处理 ≤ quota 只（quota=2、未覆盖 5 只 → 只请求 2 只）。"""
    masters = [await _add_master(session, code=f"600{500 + i}") for i in range(5)]
    # 待补证券集合来自 security_dividends（路线 B 以分红事件表的 master_id 为全集）
    for m in masters:
        session.add(SecurityDividend(
            master_id=m.id, report_year=2024, report_quarter=1,
            period_type=ReportPeriodType.ANNUAL,
            cash_per_share=Decimal("1.0"), status=DividendStatus.PAID,
        ))
    itf = await _seed_sdk_quote_source(session)
    await session.commit()
    settings = (
        await session.execute(select(DividendYieldSettings).limit(1))
    ).scalar_one()
    settings.price_backfill_source_interface_id = itf.id
    settings.price_backfill_start_date = date(2024, 1, 1)
    settings.price_backfill_quota = 2  # 每日额度 2
    await session.commit()

    fetched: list[str] = []
    expected = {f"600{500 + i}" for i in range(5)}  # 5 只待补的纯数字代码

    async def _fake_sdk(self, itf_obj, params, codes):
        fetched.append(params["symbol"])
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,)
    )
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MIN", 0
    )
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MAX", 0
    )

    msg = await run_pending_price_backfill(session)
    # 关键：只处理 quota=2 只，而非全池 5 只
    assert len(fetched) == 2
    assert set(fetched) <= expected  # 实际发请求的都在待补集合内
    assert "在途" in msg or "回补" in msg


@pytest.mark.asyncio
async def test_run_pending_price_backfill_clears_when_all_covered(session, monkeypatch):
    """守护形态 A：在途 + 全部已覆盖 → 清空 price_backfill_start_date 且零请求（终态）。"""
    masters = [await _add_master(session, code=f"600{600 + i}") for i in range(3)]
    # 待补证券集合来自 security_dividends（路线 B 以分红事件表的 master_id 为全集）
    for m in masters:
        session.add(SecurityDividend(
            master_id=m.id, report_year=2024, report_quarter=1,
            period_type=ReportPeriodType.ANNUAL,
            cash_per_share=Decimal("1.0"), status=DividendStatus.PAID,
        ))
    itf = await _seed_sdk_quote_source(session)
    await session.commit()
    settings = (
        await session.execute(select(DividendYieldSettings).limit(1))
    ).scalar_one()
    settings.price_backfill_source_interface_id = itf.id
    settings.price_backfill_start_date = date(2024, 1, 1)
    await session.commit()
    # 全部已覆盖：每只都已有 trade_date <= start_date 的日线行
    for m in masters:
        session.add(MarketSecurityDailyPrice(
            master_id=m.id, trade_date=date(2023, 1, 1), close=Decimal("10"),
        ))
    await session.commit()

    calls = {"n": 0}

    async def _fake_sdk(self, itf_obj, params, codes):
        calls["n"] += 1
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    msg = await run_pending_price_backfill(session)
    assert calls["n"] == 0  # 零请求（补完，不发任何请求）
    # 重新读 settings：在途状态已清空（终态，此后不再跑，避免无限循环白烧配额）
    settings2 = (
        await session.execute(select(DividendYieldSettings).limit(1))
    ).scalar_one()
    assert settings2.price_backfill_start_date is None
    assert "完成" in msg or "结束" in msg


@pytest.mark.asyncio
async def test_daily_close_fetch_pending_backfill_is_noop_when_no_task(session, monkeypatch):
    """守护形态 A：无在途任务时 daily_close_fetch 不发起历史回补（backfill_historical 零调用）。

    无在途任务必须是纯 no-op：不发请求、不改数据，否则会打破既有每日抓取测试。
    """
    import app.services.market_daily_price_sync as mds

    today = today_app_tz()
    session.add(MarketTradeCalendar(trade_date=today))
    m = await _add_master(session)
    session.add(
        SecurityDividend(master_id=m.id, report_year=today.year, report_quarter=1,
                         period_type=ReportPeriodType.ANNUAL,
                         cash_per_share=Decimal("1.0"), status=DividendStatus.PAID)
    )
    await _seed_sdk_quote_source(session)  # settings 行（start_date 为空）
    await session.commit()

    called = {"n": 0}

    async def _spy(itf, master_ids, start_date):
        called["n"] += 1
        return "spy"

    monkeypatch.setattr(mds, "backfill_historical", _spy)

    svc = MarketDailyPriceSyncService(session)
    result = await svc.daily_close_fetch({})
    assert called["n"] == 0  # 无在途任务 → 不触发回补
    assert "每日额度回补" not in result  # 结果串不含在途回补段

@pytest.mark.asyncio
async def test_run_pending_price_backfill_consumes_daily_quota(session, monkeypatch):
    """额度按**自然日**消耗：同日第二次执行只能在剩余额度内，用尽则零请求。

    口径：``used_today`` 按「本批实际处理只数」累加（成败都计），跨日自动归零。
    修复前每次调用都 ``limit(quota)``，导致触发当天（手动 1 批 + 收盘价抓取续跑 1 批）
    跑掉 2×quota，与「额度是每天的」冲突。
    """
    masters = [await _add_master(session, code=f"600{700 + i}") for i in range(5)]
    for m in masters:
        session.add(SecurityDividend(
            master_id=m.id, report_year=2024, report_quarter=1,
            period_type=ReportPeriodType.ANNUAL,
            cash_per_share=Decimal("1.0"), status=DividendStatus.PAID,
        ))
    itf = await _seed_sdk_quote_source(session)
    await session.commit()
    settings = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    settings.price_backfill_source_interface_id = itf.id
    settings.price_backfill_start_date = date(2024, 1, 1)
    settings.price_backfill_quota = 2
    await session.commit()

    fetched: list[str] = []

    async def _fake_sdk(self, itf_obj, params, codes):
        fetched.append(params["symbol"])
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,))
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MIN", 0)
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MAX", 0)

    # 第一次：跑满 quota=2，并记账
    await run_pending_price_backfill(session)
    assert len(fetched) == 2
    s2 = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    assert s2.price_backfill_used_today == 2
    assert s2.price_backfill_last_run_date == today_app_tz()

    # 第二次（同一天）：余额 0 → 零请求，且不再消耗
    fetched.clear()
    msg = await run_pending_price_backfill(session)
    assert fetched == [], "当日额度用尽后不得再发请求"
    assert "额度已用尽" in msg


@pytest.mark.asyncio
async def test_run_pending_price_backfill_resets_quota_on_new_day(session, monkeypatch):
    """跨日重置：last_run_date ≠ 今天 → used_today 归零，额度恢复。"""
    masters = [await _add_master(session, code=f"600{800 + i}") for i in range(5)]
    for m in masters:
        session.add(SecurityDividend(
            master_id=m.id, report_year=2024, report_quarter=1,
            period_type=ReportPeriodType.ANNUAL,
            cash_per_share=Decimal("1.0"), status=DividendStatus.PAID,
        ))
    itf = await _seed_sdk_quote_source(session)
    await session.commit()
    settings = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    settings.price_backfill_source_interface_id = itf.id
    settings.price_backfill_start_date = date(2024, 1, 1)
    settings.price_backfill_quota = 2
    # 记账停在「很久以前」且已用满 → 今天应重置
    settings.price_backfill_last_run_date = date(2000, 1, 1)
    settings.price_backfill_used_today = 2
    await session.commit()

    fetched: list[str] = []

    async def _fake_sdk(self, itf_obj, params, codes):
        fetched.append(params["symbol"])
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,))
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MIN", 0)
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MAX", 0)

    await run_pending_price_backfill(session)
    assert len(fetched) == 2  # 重置后额度恢复，可再跑满 2 只
    s2 = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    assert s2.price_backfill_last_run_date == today_app_tz()
    assert s2.price_backfill_used_today == 2


# ─────────── 熔断批额度补记 + 失败原因回写（R3 / 3536e20） ───────────
@pytest.mark.asyncio
async def test_breaker_still_counts_burst_quota_and_writes_last_error(session, monkeypatch):
    """熔断中止时：本批额度必须照计（R3），且失败原因要回写 settings 供前端展示。

    回归点：循环末尾那句 burst 记账在 ``raise RuntimeError`` 之后不会执行；
    若不在熔断前补记，该批整体漏计 → 当日额度被低估，与「成败都计」口径不符。
    """
    masters = [await _add_master(session, code=f"600{900 + i}") for i in range(10)]
    for m in masters:
        # 待回补证券须有分红记录，_select_pending_backfill_masters 才会选中它们
        session.add(SecurityDividend(
            master_id=m.id, report_year=2024, report_quarter=1,
            period_type=ReportPeriodType.ANNUAL,
            cash_per_share=Decimal("1.0"), status=DividendStatus.PAID,
        ))
    itf = await _seed_sdk_quote_source(session)
    await session.commit()
    settings = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    settings.price_backfill_source_interface_id = itf.id
    settings.price_backfill_start_date = date(2024, 1, 1)
    settings.price_backfill_quota = 1000
    await session.commit()

    async def _always_fail(self, itf_obj, params, codes):
        raise RuntimeError("数据源定向拒连（模拟）")

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _always_fail)
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,))
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_FAILURE_BREAKER", 3
    )

    with pytest.raises(RuntimeError):
        await run_pending_price_backfill(session)

    s2 = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    # R3：熔断批（本 burst 分配 10 只）也要计入当日已用，不能因 raise 而漏计
    assert s2.price_backfill_used_today == 10
    # 失败原因回写，前端在「在途」旁可见
    assert s2.price_backfill_last_error is not None
    assert "熔断" in s2.price_backfill_last_error
    # 在途标记保留（可续跑），不能被熔断清掉
    assert s2.price_backfill_start_date == date(2024, 1, 1)


@pytest.mark.asyncio
async def test_rerun_clears_previous_last_error(session, monkeypatch):
    """新一轮续跑开始时应清空上一次遗留的失败原因（成功后前端不再显示旧错误）。"""
    masters = [await _add_master(session, code=f"600{950 + i}") for i in range(3)]
    for m in masters:
        session.add(SecurityDividend(
            master_id=m.id, report_year=2024, report_quarter=1,
            period_type=ReportPeriodType.ANNUAL,
            cash_per_share=Decimal("1.0"), status=DividendStatus.PAID,
        ))
    itf = await _seed_sdk_quote_source(session)
    await session.commit()
    settings = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    settings.price_backfill_source_interface_id = itf.id
    settings.price_backfill_start_date = date(2024, 1, 1)
    settings.price_backfill_quota = 1000
    # 预置「上一次熔断」的失败原因，验证新一轮开始即清空
    settings.price_backfill_last_error = "上一次熔断：连续失败 3 只"
    await session.commit()

    async def _ok(self, itf_obj, params, codes):
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _ok)
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,))
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MIN", 0)
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MAX", 0)

    await run_pending_price_backfill(session)

    s2 = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    assert s2.price_backfill_last_error is None, "续跑开始即清空旧失败原因"
