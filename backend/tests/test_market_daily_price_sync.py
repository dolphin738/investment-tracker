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
from sqlalchemy import select, text

from app.core.date_utils import today_app_tz
from app.models import (
    DividendYieldSettings,
    GAP_STATUS_PENDING,
    MarketPriceBackfillGap,
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
    _acquire_backfill_lease,
    _select_gap_backfill_masters,
    _select_pending_backfill_masters,
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


# ───────────────────────── 方案 D：腾讯源自动跳过京A（BJ） ─────────────────────────

@pytest.mark.asyncio
async def test_select_pending_backfill_masters_skips_bj(session):
    """守护方案 D：传 skip_exchange='BJ' 时京A证券不入选；不传则照常入选（对照组）。"""
    bj = Security(id=_uid(), code="830799", name="北交所A", asset_class=SecurityType.STOCK, exchange="BJ")
    sh = Security(id=_uid(), code="600000", name="浦发银行", asset_class=SecurityType.STOCK, exchange="SH")
    session.add_all([bj, sh])
    await session.flush()
    for m in (bj, sh):
        session.add(SecurityDividend(
            master_id=m.id, report_year=2024, report_quarter=1,
            period_type=ReportPeriodType.ANNUAL,
            cash_per_share=Decimal("1.0"), status=DividendStatus.PAID,
        ))
    await session.commit()

    # 有跳过：BJ 被排除，SH 保留
    pending = await _select_pending_backfill_masters(
        session, date(2024, 1, 1), 10, skip_exchange="BJ"
    )
    assert bj.id not in pending
    assert sh.id in pending

    # 对照组：不传 skip_exchange，BJ 也入选
    pending_all = await _select_pending_backfill_masters(session, date(2024, 1, 1), 10)
    assert bj.id in pending_all and sh.id in pending_all



@pytest.mark.asyncio
async def test_run_pending_price_backfill_skips_bj_for_tencent_source(session, monkeypatch):
    """守护方案 D 端到端：回补源为腾讯历史行情接口（stock_zh_a_hist_tx）时，京A证券不被请求。"""
    bj = Security(id=_uid(), code="830799", name="北交所A", asset_class=SecurityType.STOCK, exchange="BJ")
    sh = Security(id=_uid(), code="600000", name="浦发银行", asset_class=SecurityType.STOCK, exchange="SH")
    session.add_all([bj, sh])
    await session.flush()
    for m in (bj, sh):
        session.add(SecurityDividend(
            master_id=m.id, report_year=2024, report_quarter=1,
            period_type=ReportPeriodType.ANNUAL,
            cash_per_share=Decimal("1.0"), status=DividendStatus.PAID,
        ))
    provider = SecuritiesDataProvider(
        id=_uid(), name="akshare-tx", access_method=QuoteProviderAccessMethod.SDK,
        config={}, enabled=True,
    )
    session.add(provider)
    await session.flush()  # provider 先落库（id 由 DB 端 gen_random_uuid 生成）
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID,
        name="腾讯-历史行情", endpoint="stock_zh_a_hist_tx", http_method="GET",
        enabled=True, priority=1,
        # 声明英文响应列：code/price/date 三槽齐全
        response_fields=[
            {"key": "code", "slot": "code", "source": "code"},
            {"key": "close", "slot": "price", "source": "close"},
            {"key": "date", "slot": "date", "source": "date"},
        ],
        params={},
    )
    session.add(itf)
    await session.flush()
    settings = DividendYieldSettings(
        green_threshold=Decimal("0.05"), red_threshold=Decimal("0.03"),
        price_source_interface_id=itf.id,
        price_backfill_source_interface_id=itf.id,
        price_backfill_start_date=date(2024, 1, 1),
        price_backfill_quota=10,
    )
    session.add(settings)
    await session.commit()

    fetched: list[str] = []

    async def _fake_sdk(self, itf_obj, params, codes):
        fetched.append(params["symbol"])
        return [{"date": "2024-01-02", "close": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,))
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MIN", 0)
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MAX", 0)

    await run_pending_price_backfill(session)

    # 腾讯源不含京A数据 → BJ 代码 830799 不应被请求；沪市 600000 正常回补
    assert "830799" not in fetched
    assert "600000" in fetched


# ───── 协作式取消（世代标记 run_token）：取消 / 被取代后不再抓取剩余证券 ─────
