"""日线抓取服务单测（日内侧：双防线 + 回补入口 + 无在途 no-op；mock 网络层）。

自 ``test_market_daily_price_sync.py`` 拆出（T04 测试拆分，每个文件 ≤400 行）。
守护决策 A9（双防线：交易日历校验主 + 返回日期比对备）/ §6.2 / P1-3（回补生产入口）。

回补常量/批次可观测性/日志 → ``test_market_daily_price_logging.py``；
在途回补（额度/游标/方案 D）→ ``test_market_price_backfill_pending.py``。
"""
from __future__ import annotations

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
    SecurityDividend,
)
from app.models.enums import (
    DividendStatus,
    QuoteProviderAccessMethod,
    ReportPeriodType,
)
from app.models.interface_category import InterfaceCategory
from app.services.market_data_sync import QUOTE_CAT_ID, MarketDataSyncService
from app.services.market_daily_price_sync import MarketDailyPriceSyncService
from tests.helpers_price_backfill import add_master, seed_sdk_quote_source, uid


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
    m = await add_master(session)
    session.add(
        SecurityDividend(master_id=m.id, report_year=today.year, report_quarter=1,
                         period_type=ReportPeriodType.ANNUAL,
                         cash_per_share=Decimal("1.0"), status=DividendStatus.PAID)
    )
    provider = SecuritiesDataProvider(
        id=uid(), name="腾讯", access_method=QuoteProviderAccessMethod.HTTPS,
        config={"base_url": "https://qt.gtimg.cn"}, enabled=True,
    )
    itf = QuoteInterface(
        id=uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID, name="腾讯",
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
    session.add(DividendYieldSettings(
                                      price_source_interface_id=itf.id))
    await session.commit()

    svc = MarketDailyPriceSyncService(session)

    async def _fake_raw(itf_obj, params, codes):
        return [{"代码": "600000", "收盘": "10.5", "日期": "2020-01-01"}]  # 上一交易日

    svc._mds._call_interface_raw = _fake_raw
    # T2 行为变更（本用例属「全批失败 ⇒ 零写入」）：daily_close_fetch 现抛 RuntimeError，
    # 消息 = 完整 summary（含「失败批次 1 / 成功行 0」）。依据：用户要求「成功批次 0 且失败
    # 批次 > 0」判任务失败；零写入即失败对幂等重跑安全（_upsert_day_rows 对已存在同日行也
    # 算写入）。故把原「返回串断言」改为「异常消息断言」，并保留「未写入任何日线行」断言。
    with pytest.raises(RuntimeError, match="失败批次 1"):
        await svc.daily_close_fetch({})

    # 该批次被整批丢弃，未写入任何日线行
    rows = (await session.execute(select(MarketSecurityDailyPrice))).scalars().all()
    assert rows == []


@pytest.mark.asyncio
async def test_daily_close_fetch_writes_on_matching_date(session):
    """守护 §6.2：返回日期 == 今日 → 幂等写入当日收盘价并重算派生快照。"""
    today = today_app_tz()
    session.add(MarketTradeCalendar(trade_date=today))
    m = await add_master(session)
    session.add(
        SecurityDividend(master_id=m.id, report_year=today.year, report_quarter=4,
                         period_type=ReportPeriodType.ANNUAL,
                         cash_per_share=Decimal("1.0"), status=DividendStatus.PAID)
    )
    provider = SecuritiesDataProvider(
        id=uid(), name="腾讯", access_method=QuoteProviderAccessMethod.HTTPS,
        config={"base_url": "https://qt.gtimg.cn"}, enabled=True,
    )
    itf = QuoteInterface(
        id=uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID, name="腾讯",
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
    session.add(DividendYieldSettings(
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
    m1 = await add_master(session, code="600001")
    m2 = await add_master(session, code="600002")
    for m in (m1, m2):
        session.add(
            SecurityDividend(master_id=m.id, report_year=today.year, report_quarter=1,
                             period_type=ReportPeriodType.ANNUAL,
                             cash_per_share=Decimal("1.0"), status=DividendStatus.PAID)
        )
    provider = SecuritiesDataProvider(
        id=uid(), name="腾讯", access_method=QuoteProviderAccessMethod.HTTPS,
        config={"base_url": "https://qt.gtimg.cn"}, enabled=True,
    )
    itf = QuoteInterface(
        id=uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID, name="腾讯",
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
    session.add(DividendYieldSettings(
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
    # T2 行为变更（本用例属「全批失败 ⇒ 零写入」）：整批停牌污染被拦后零写入 → 抛 RuntimeError。
    # 依据同上（零写入判失败，且对幂等重跑安全）。保留「未写入任何日线行」断言。
    with pytest.raises(RuntimeError, match="失败批次 1"):
        await svc.daily_close_fetch({})

    rows = (await session.execute(select(MarketSecurityDailyPrice))).scalars().all()
    assert rows == []  # 混合日期批次整批跳过，停牌脏价不得写入


# ───────────────────────── 回补 symbol 剥离（P2-2，§6.2） ─────────────────────────

@pytest.mark.asyncio
async def test_daily_close_fetch_backfill_entry_non_sdk_fails_fast(session):
    """守护 P1-3：行情源非 SDK 时配置 backfill_start → fail fast 落 FAILED。"""
    import types

    today = today_app_tz()
    session.add(MarketTradeCalendar(trade_date=today))
    m = await add_master(session)
    session.add(
        SecurityDividend(master_id=m.id, report_year=today.year, report_quarter=1,
                         period_type=ReportPeriodType.ANNUAL,
                         cash_per_share=Decimal("1.0"), status=DividendStatus.PAID)
    )
    provider = SecuritiesDataProvider(
        id=uid(), name="腾讯", access_method=QuoteProviderAccessMethod.HTTPS,
        config={"base_url": "https://qt.gtimg.cn"}, enabled=True,
    )
    itf = QuoteInterface(
        id=uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID, name="腾讯",
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
    session.add(DividendYieldSettings(
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
    m = await add_master(session)
    session.add(
        SecurityDividend(master_id=m.id, report_year=today.year, report_quarter=1,
                         period_type=ReportPeriodType.ANNUAL,
                         cash_per_share=Decimal("1.0"), status=DividendStatus.PAID)
    )
    await seed_sdk_quote_source(session)
    await session.commit()

    async def _fake_sdk(self, itf_obj, params, codes):
        # 日抓（codes 非空）与回补（codes=None）共用 SDK 链路，按形状区分返回
        if codes:
            return [{"代码": "600000", "收盘": "10.5"}]
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    monkeypatch.setattr(
        "app.services.market_price_backfill_engine._BACKFILL_BACKOFFS", (0,)
    )

    svc = MarketDailyPriceSyncService(session)
    cfg = types.SimpleNamespace(params={"backfill_start": "2023-01-01"})
    result = await svc.daily_close_fetch(cfg)

    assert "历史回补完成" in result
    rows = (await session.execute(select(MarketSecurityDailyPrice))).scalars().all()
    dates = {r.trade_date for r in rows}
    assert today in dates          # 日抓正常写入当日
    assert date(2024, 1, 2) in dates  # 回补写入历史行


# ───────────────────────── 在途回补 no-op（§6.2 在途任务） ─────────────────────────

@pytest.mark.asyncio
async def test_daily_close_fetch_pending_backfill_is_noop_when_no_task(session, monkeypatch):
    """守护形态 A：无在途任务时 daily_close_fetch 不发起历史回补（backfill_historical 零调用）。

    无在途任务必须是纯 no-op：不发请求、不改数据，否则会打破既有每日抓取测试。
    """
    import app.services.market_price_backfill_engine as mds

    today = today_app_tz()
    session.add(MarketTradeCalendar(trade_date=today))
    m = await add_master(session)
    session.add(
        SecurityDividend(master_id=m.id, report_year=today.year, report_quarter=1,
                         period_type=ReportPeriodType.ANNUAL,
                         cash_per_share=Decimal("1.0"), status=DividendStatus.PAID)
    )
    await seed_sdk_quote_source(session)  # settings 行（start_date 为空）
    await session.commit()

    called = {"n": 0}

    async def _spy(itf, master_ids, start_date):
        called["n"] += 1
        return "spy"

    monkeypatch.setattr(mds, "backfill_historical", _spy)

    svc = MarketDailyPriceSyncService(session)

    # 让「日抓」正常成功（写入 1 行）。本用例的目的是验证「无在途任务 → 不触发回补」，
    # 而非源失败路径；若不接管网络层，SDK 源（stock_zh_a_hist）会因缺少 symbol 参数报错 →
    # 零写入 → 触发 T2 抛错，反而掩盖本用例真正的断言目标。故此处显式让日抓成功。
    async def _fake_raw(itf_obj, params, codes):
        return [{"代码": "600000", "收盘": "10.5"}]

    svc._mds._call_interface_raw = _fake_raw
    result = await svc.daily_close_fetch({})
    assert called["n"] == 0  # 无在途任务 → 不触发回补
    assert "每日额度回补" not in result  # 结果串不含在途回补段
