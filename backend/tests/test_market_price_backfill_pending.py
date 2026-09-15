"""在途回补（实测）单测：每日额度 / 游标 / 方案 D 跳过京A（mock 网络层）。

自 ``test_market_daily_price_sync.py`` 拆出（T04 测试拆分，每个文件 ≤400 行）。
守护形态 A（每日额度分批补完即清空）、额度按自然日消耗、方案 D（腾讯源自动跳过 BJ）。
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
    QuoteInterface,
    SecuritiesDataProvider,
    Security,
    SecurityDividend,
)
from app.models.enums import (
    DividendStatus,
    QuoteProviderAccessMethod,
    ReportPeriodType,
    SecurityType,
)
from app.models.interface_category import InterfaceCategory
from app.services.market_data_sync import QUOTE_CAT_ID, MarketDataSyncService
from app.services.market_daily_price_sync import (
    _select_pending_backfill_masters,
    run_pending_price_backfill,
)
from tests.helpers_price_backfill import add_master, seed_sdk_quote_source, uid


@pytest.mark.asyncio
async def test_run_pending_price_backfill_no_pending_makes_no_request(session, monkeypatch):
    """守护形态 A：无在途任务（price_backfill_start_date 为空）→ 直接返回提示、不发任何请求。"""
    await seed_sdk_quote_source(session)  # 造 settings 行（start_date 为空）
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
    masters = [await add_master(session, code=f"600{500 + i}") for i in range(5)]
    # 待补证券集合来自 security_dividends（路线 B 以分红事件表的 master_id 为全集）
    for m in masters:
        session.add(SecurityDividend(
            master_id=m.id, report_year=2024, report_quarter=1,
            period_type=ReportPeriodType.ANNUAL,
            cash_per_share=Decimal("1.0"), status=DividendStatus.PAID,
        ))
    itf = await seed_sdk_quote_source(session)
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
        "app.services.market_price_backfill_engine._BACKFILL_BACKOFFS", (0,)
    )
    monkeypatch.setattr(
        "app.services.market_price_backfill_engine._BACKFILL_COOLDOWN_MIN", 0
    )
    monkeypatch.setattr(
        "app.services.market_price_backfill_engine._BACKFILL_COOLDOWN_MAX", 0
    )

    msg = await run_pending_price_backfill(session)
    # 关键：只处理 quota=2 只，而非全池 5 只
    assert len(fetched) == 2
    assert set(fetched) <= expected  # 实际发请求的都在待补集合内
    assert "在途" in msg or "回补" in msg


@pytest.mark.asyncio
async def test_run_pending_price_backfill_clears_when_all_covered(session, monkeypatch):
    """守护形态 A：在途 + 全部已覆盖 → 清空 price_backfill_start_date 且零请求（终态）。"""
    masters = [await add_master(session, code=f"600{600 + i}") for i in range(3)]
    # 待补证券集合来自 security_dividends（路线 B 以分红事件表的 master_id 为全集）
    for m in masters:
        session.add(SecurityDividend(
            master_id=m.id, report_year=2024, report_quarter=1,
            period_type=ReportPeriodType.ANNUAL,
            cash_per_share=Decimal("1.0"), status=DividendStatus.PAID,
        ))
    itf = await seed_sdk_quote_source(session)
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
async def test_run_pending_price_backfill_consumes_daily_quota(session, monkeypatch):
    """额度按**自然日**消耗：同日第二次执行只能在剩余额度内，用尽则零请求。

    口径：``used_today`` 按「本批实际处理只数」累加（成败都计），跨日自动归零。
    修复前每次调用都 ``limit(quota)``，导致触发当天（手动 1 批 + 收盘价抓取续跑 1 批）
    跑掉 2×quota，与「额度是每天的」冲突。
    """
    masters = [await add_master(session, code=f"600{700 + i}") for i in range(5)]
    for m in masters:
        session.add(SecurityDividend(
            master_id=m.id, report_year=2024, report_quarter=1,
            period_type=ReportPeriodType.ANNUAL,
            cash_per_share=Decimal("1.0"), status=DividendStatus.PAID,
        ))
    itf = await seed_sdk_quote_source(session)
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
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_BACKOFFS", (0,))
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_COOLDOWN_MIN", 0)
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_COOLDOWN_MAX", 0)

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
    masters = [await add_master(session, code=f"600{800 + i}") for i in range(5)]
    for m in masters:
        session.add(SecurityDividend(
            master_id=m.id, report_year=2024, report_quarter=1,
            period_type=ReportPeriodType.ANNUAL,
            cash_per_share=Decimal("1.0"), status=DividendStatus.PAID,
        ))
    itf = await seed_sdk_quote_source(session)
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
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_BACKOFFS", (0,))
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_COOLDOWN_MIN", 0)
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_COOLDOWN_MAX", 0)

    await run_pending_price_backfill(session)
    assert len(fetched) == 2  # 重置后额度恢复，可再跑满 2 只
    s2 = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    assert s2.price_backfill_last_run_date == today_app_tz()
    assert s2.price_backfill_used_today == 2


@pytest.mark.asyncio
async def test_rerun_clears_previous_last_error(session, monkeypatch):
    """新一轮续跑开始时应清空上一次遗留的失败原因（成功后前端不再显示旧错误）。"""
    masters = [await add_master(session, code=f"600{950 + i}") for i in range(3)]
    for m in masters:
        session.add(SecurityDividend(
            master_id=m.id, report_year=2024, report_quarter=1,
            period_type=ReportPeriodType.ANNUAL,
            cash_per_share=Decimal("1.0"), status=DividendStatus.PAID,
        ))
    itf = await seed_sdk_quote_source(session)
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
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_BACKOFFS", (0,))
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_COOLDOWN_MIN", 0)
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_COOLDOWN_MAX", 0)

    await run_pending_price_backfill(session)

    s2 = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    assert s2.price_backfill_last_error is None, "续跑开始即清空旧失败原因"


@pytest.mark.asyncio
async def test_select_pending_backfill_masters_skips_bj(session):
    """守护方案 D：传 skip_exchange='BJ' 时京A证券不入选；不传则照常入选（对照组）。"""
    bj = Security(id=uid(), code="830799", name="北交所A", asset_class=SecurityType.STOCK, exchange="BJ")
    sh = Security(id=uid(), code="600000", name="浦发银行", asset_class=SecurityType.STOCK, exchange="SH")
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
    bj = Security(id=uid(), code="830799", name="北交所A", asset_class=SecurityType.STOCK, exchange="BJ")
    sh = Security(id=uid(), code="600000", name="浦发银行", asset_class=SecurityType.STOCK, exchange="SH")
    session.add_all([bj, sh])
    await session.flush()
    for m in (bj, sh):
        session.add(SecurityDividend(
            master_id=m.id, report_year=2024, report_quarter=1,
            period_type=ReportPeriodType.ANNUAL,
            cash_per_share=Decimal("1.0"), status=DividendStatus.PAID,
        ))
    provider = SecuritiesDataProvider(
        id=uid(), name="akshare-tx", access_method=QuoteProviderAccessMethod.SDK,
        config={}, enabled=True,
    )
    session.add(provider)
    await session.flush()  # provider 先落库（id 由 DB 端 gen_random_uuid 生成）
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    itf = QuoteInterface(
        id=uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID,
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
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_BACKOFFS", (0,))
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_COOLDOWN_MIN", 0)
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_COOLDOWN_MAX", 0)

    await run_pending_price_backfill(session)

    # 腾讯源不含京A数据 → BJ 代码 830799 不应被请求；沪市 600000 正常回补
    assert "830799" not in fetched
    assert "600000" in fetched
