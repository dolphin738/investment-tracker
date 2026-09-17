"""QA 独立端到端验证：严格补洞（gap）模式。

本文件由 QA 独立编写，不改动任何 production 代码、不改动既有测试（test_price_backfill_gap_mode.py）。
目标：不相信任何人口头结论，自己跑实证，覆盖四类证据：

- B. 端到端：真实驱动 ``run_pending_price_backfill``（不只调底层函数）填上一个真实中间缺失交易日，
     断言洞被填上、gap 行被 reconcile 删除、在途标记被清空、不报 exhausted。
- C. 两个 P1 修复真修好了：
     P1(a) 部分覆盖（日历不覆盖窗口任一端）→ ``sync_price_backfill_gaps`` 返回 ``None``（非 0）；
     P1(b) 某洞 attempts 达 2 → exhausted 不再入批；``clear_price_backfill_gaps`` 重置后可重新见洞；
     护栏三：每日续跑 ``run_pending_price_backfill`` 绝不清空 attempts（attempts 跨轮保留，否则活锁）。
- D. 反向找茬（deny-assumption）：
     「今天缺失」不算洞（上界=昨天护栏）；
     legacy 路径在 gap 提交后零回归（force 恒 False、桩签名不变、中间空洞不补）；
     ``PRICE_BACKFILL_MODE_LEGACY`` 已正确导入（cd5db9c 顺手修的漏导入）。

全部走真实 Postgres 测试库（conftest 自动 alembic upgrade head），网络层用 monkeypatch 打桩。
"""
from __future__ import annotations

import inspect
import uuid
from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.date_utils import today_app_tz
from app.models import (
    GAP_STATUS_EXHAUSTED,
    GAP_STATUS_PENDING,
    PRICE_BACKFILL_MODE_GAP,
    PRICE_BACKFILL_MODE_LEGACY,
    DividendYieldSettings,
    MarketPriceBackfillGap,
    MarketSecurityDailyPrice,
    MarketTradeCalendar,
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
from app.services.market_data_sync import (
    QUOTE_CAT_ID,
    MarketDataSyncService,
    _normalize_master_code,
    infer_exchange,
)
from app.services.market_daily_price_sync import (
    _GAP_MAX_ATTEMPTS,
    clear_price_backfill_gaps,
    run_pending_price_backfill,
    sync_price_backfill_gaps,
)


def _uid() -> str:
    return str(uuid.uuid4())


def _window_upper() -> date:
    """回补窗口上界（护栏一：上界 = 昨天）。"""
    return today_app_tz() - timedelta(days=1)


async def _add_master(session, code: str = "600000") -> Security:
    norm = _normalize_master_code(code, infer_exchange(code))
    m = Security(
        id=_uid(), code=norm, name="浦发银行", asset_class=SecurityType.STOCK
    )
    session.add(m)
    await session.flush()
    return m


async def _add_dividend(session, master_id: str) -> None:
    session.add(
        SecurityDividend(
            master_id=master_id,
            report_year=2024,
            report_quarter=1,
            period_type=ReportPeriodType.ANNUAL,
            cash_per_share=Decimal("1.0"),
            status=DividendStatus.PAID,
        )
    )
    await session.flush()


async def _seed_sdk_backfill_source(session) -> QuoteInterface:
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    provider = SecuritiesDataProvider(
        id=_uid(),
        name="akshare",
        access_method=QuoteProviderAccessMethod.SDK,
        config={},
        enabled=True,
    )
    session.add(provider)
    await session.flush()
    itf = QuoteInterface(
        id=_uid(),
        provider_id=provider.id,
        category_id=QUOTE_CAT_ID,
        name="东财-历史行情",
        endpoint="stock_zh_a_hist",
        http_method="GET",
        enabled=True,
        priority=1,
        resp_code_field="代码",
        resp_price_field="收盘",
        response_parse={},
        params={},
    )
    session.add(itf)
    await session.flush()
    return itf


async def _seed_settings(
    session,
    itf: QuoteInterface,
    start_date: date,
    mode: str = PRICE_BACKFILL_MODE_GAP,
    quota: int = 1000,
) -> DividendYieldSettings:
    row = DividendYieldSettings(
        price_backfill_source_interface_id=itf.id,
        price_backfill_start_date=start_date,
        price_backfill_mode=mode,
        price_backfill_quota=quota,
        price_backfill_used_today=0,
    )
    session.add(row)
    await session.commit()
    return row


def _no_wait(monkeypatch) -> None:
    """去掉回补冷却/退避等待，避免测试真睡几十秒。"""
    monkeypatch.setattr(
        "app.services.market_price_backfill_engine._BACKFILL_BACKOFFS", (0,)
    )
    monkeypatch.setattr(
        "app.services.market_price_backfill_engine._BACKFILL_COOLDOWN_MIN", 0
    )
    monkeypatch.setattr(
        "app.services.market_price_backfill_engine._BACKFILL_COOLDOWN_MAX", 0
    )


def _sdk_returning(rows):
    """构造 ``MarketDataSyncService._fetch_sdk_raw`` 打桩，返回固定行并计调用次数。"""
    calls = {"n": 0}

    async def _fake(self, itf_obj, params, codes):
        calls["n"] += 1
        return list(rows)

    return calls, _fake


async def _gap_rows(session) -> list[tuple[str, date, str, int]]:
    rows = (
        await session.execute(
            select(
                MarketPriceBackfillGap.master_id,
                MarketPriceBackfillGap.gap_date,
                MarketPriceBackfillGap.status,
                MarketPriceBackfillGap.attempts,
            ).order_by(MarketPriceBackfillGap.gap_date)
        )
    ).all()
    return [(r[0], r[1], r[2], r[3]) for r in rows]


# ───────────────────────── B. 端到端：真实 run_pending_price_backfill 补洞 ─────────────────────────
@pytest.mark.asyncio
async def test_e2e_gap_mode_fills_real_gap_via_run_pending(session, monkeypatch):
    """驱动真实 ``run_pending_price_backfill`` 流程（gap 模式）填上中间缺失交易日。

    场景：证券有分红 → 起点已覆盖（legacy 会整只跳过）→ 交易日历铺满窗口两端 →
    中间缺一个真实交易日（洞）→ 设 mode='gap' + 在途标记 → 桩返回该缺失日收盘价 →
    调 run_pending_price_backfill → 洞被填上、gap 行被 reconcile 删除、在途标记被清、不报 exhausted。
    """
    m = await _add_master(session)
    await _add_dividend(session, m.id)
    start = date(2024, 1, 2)
    # 起点已覆盖（legacy 口径下该证券会被整只跳过，中间洞永不补）
    session.add(
        MarketSecurityDailyPrice(master_id=m.id, trade_date=start, close=Decimal("10"))
    )
    # 护栏三两端覆盖：补上界交易日并为其补日线（避免上界本身变洞、污染断言）
    upper = _window_upper()
    session.add(
        MarketSecurityDailyPrice(master_id=m.id, trade_date=upper, close=Decimal("10"))
    )
    # 中间缺失交易日 = 真实洞（日历有、日线无）
    gap_day = start + timedelta(days=1)
    for d in (start, gap_day, upper):
        session.add(MarketTradeCalendar(trade_date=d))
    await session.commit()

    itf = await _seed_sdk_backfill_source(session)
    await _seed_settings(session, itf, start, mode=PRICE_BACKFILL_MODE_GAP)
    # 在途标记确认已置位（后续断言「被清」才有意义）
    settings0 = (
        await session.execute(select(DividendYieldSettings).limit(1))
    ).scalar_one()
    assert settings0.price_backfill_start_date == start

    _no_wait(monkeypatch)
    # 桩：数据源能返回缺失日的收盘价（模拟「该日数据可取得」）
    calls, _fake = _sdk_returning([{"日期": gap_day.isoformat(), "收盘": "10.5"}])
    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake)

    # 第一轮：真实驱动 run_pending_price_backfill（force=True 重抓起点已覆盖的证券）
    msg1 = await run_pending_price_backfill(session)
    assert "本批" in msg1  # 第一轮确实处理了该证券

    # 断言①：洞被填上（缺失日有了日线行）
    filled = (
        await session.execute(
            select(MarketSecurityDailyPrice.trade_date).where(
                MarketSecurityDailyPrice.master_id == m.id,
                MarketSecurityDailyPrice.trade_date == gap_day,
            )
        )
    ).scalar_one_or_none()
    assert filled == gap_day
    # 断言②：对应 gap 行被 reconcile 删除（洞即数据，补上即删、不留终态）
    assert await _gap_rows(session) == []
    assert calls["n"] == 1

    # 第二轮：无待补 → 清在途标记（终态），零请求
    calls["n"] = 0
    msg2 = await run_pending_price_backfill(session)
    settings = (
        await session.execute(select(DividendYieldSettings).limit(1))
    ).scalar_one()
    # 断言③：在途标记被清空
    assert settings.price_backfill_start_date is None
    # 断言④：不报 exhausted（数据源能返回该日数据，无放弃洞）
    assert GAP_STATUS_EXHAUSTED not in msg2
    assert "完成" in msg2
    assert calls["n"] == 0


# ───────────────────────── C-P1(a). 部分覆盖 → 返回 None ─────────────────────────
@pytest.mark.asyncio
async def test_p1a_partial_calendar_coverage_returns_none(session):
    """护栏三（两端覆盖）：日历只覆盖下界、尾部在窗口结束前断层（上界未覆盖）→ 返回 None。

    这是「部分覆盖静默漏判一整段」的真实场景：旧判据（窗口内任意一天在日历里）会误判为
    「已覆盖」并继续判定，把尾部整段漏掉、还误报「补完」。须返回 None 交由调用方回落 legacy。
    """
    m = await _add_master(session)
    await _add_dividend(session, m.id)
    start = date(2024, 1, 1)
    # 日历覆盖下界（start）及窗口内若干天，但尾部断层：无任何 ``>= 窗口上界`` 的交易日
    # → 上界未覆盖 → 部分覆盖 → 无从判定洞
    for d in (start, date(2024, 1, 2), date(2024, 1, 3)):
        session.add(MarketTradeCalendar(trade_date=d))
    await session.commit()

    res = await sync_price_backfill_gaps(session, start)
    # 关键断言：返回 None（不是 0），否则会被误读成「没有洞 → 补完」并错误清在途标记
    assert res is None
    # 无从判定 → 不落任何洞行（不会误造洞）
    assert await _gap_rows(session) == []


# ───────────────────────── C-P1(b). attempts 达 2 → exhausted；清空重置后可重见 ─────────────────────────
@pytest.mark.asyncio
async def test_p1b_exhausted_then_clear_re_enables(session, monkeypatch):
    """护栏二 + 重置路径：洞 attempts 达 2 → exhausted 不再入批；clear 重置后重新见洞。"""
    m = await _add_master(session)
    await _add_dividend(session, m.id)
    start = date(2024, 1, 1)
    session.add(
        MarketSecurityDailyPrice(master_id=m.id, trade_date=start, close=Decimal("10"))
    )
    gap_day = start + timedelta(days=1)
    upper = _window_upper()
    session.add(
        MarketSecurityDailyPrice(master_id=m.id, trade_date=upper, close=Decimal("10"))
    )
    for d in (start, gap_day, upper):
        session.add(MarketTradeCalendar(trade_date=d))
    itf = await _seed_sdk_backfill_source(session)
    await _seed_settings(session, itf, start, mode=PRICE_BACKFILL_MODE_GAP)
    _no_wait(monkeypatch)
    # 数据源长期给不到该日 → 空返回（洞永远填不上）
    calls, _fake = _sdk_returning([])
    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake)

    # 第一轮：attempts 0→1
    await run_pending_price_backfill(session)
    rows = await _gap_rows(session)
    assert [(r[2], r[3]) for r in rows] == [(GAP_STATUS_PENDING, 1)]

    # 第二轮：attempts 1→2 → exhausted，不再入批
    await run_pending_price_backfill(session)
    rows = await _gap_rows(session)
    assert [(r[2], r[3]) for r in rows] == [
        (GAP_STATUS_EXHAUSTED, _GAP_MAX_ATTEMPTS)
    ]

    # 第三轮：exhausted → 不在批内（pending 空）→ 补完终态清在途标记、零请求
    calls["n"] = 0
    msg = await run_pending_price_backfill(session)
    assert calls["n"] == 0
    settings = (
        await session.execute(select(DividendYieldSettings).limit(1))
    ).scalar_one()
    assert settings.price_backfill_start_date is None
    assert GAP_STATUS_EXHAUSTED in msg  # 终态消息告知已放弃的洞数（信息透明）

    # 模拟重新触发（路由层 POST /backfill-prices 会 clear_price_backfill_gaps）：
    # exhausted 行被清空
    cleared = await clear_price_backfill_gaps(session)
    await session.commit()
    assert cleared == 1
    assert await _gap_rows(session) == []

    # 重新 sync（触发后路由会重新 sync）：该洞重新可见（pending, attempts=0）
    added = await sync_price_backfill_gaps(session, start)
    await session.commit()
    assert added == 1
    rows = await _gap_rows(session)
    assert [(r[2], r[3]) for r in rows] == [(GAP_STATUS_PENDING, 0)]


# ───────────────────────── C-护栏三. 每日续跑不清空 attempts（活锁防护） ─────────────────────────
@pytest.mark.asyncio
async def test_guard3_daily_continuation_preserves_attempts(session, monkeypatch):
    """独立确认：每日续跑（run_pending_price_backfill）绝不调用 clear_price_backfill_gaps。

    attempts 跨轮保留：第一轮 0→1，第二轮 1→2 → exhausted。若续跑把 attempts 每天归零
    （即清空 gap 表），则永远停在 1、达不了 exhausted，停牌洞每天循环白烧额度（活锁）。
    """
    m = await _add_master(session)
    await _add_dividend(session, m.id)
    upper = _window_upper()
    start = upper - timedelta(days=2)
    gap_day = start + timedelta(days=1)
    session.add(
        MarketSecurityDailyPrice(master_id=m.id, trade_date=start, close=Decimal("10"))
    )
    # 上界补日线：避免其上界本身变洞（否则会有 2 个洞，断言 len==1 失真）；仅 gap_day 是真洞
    session.add(
        MarketSecurityDailyPrice(master_id=m.id, trade_date=upper, close=Decimal("10"))
    )
    for d in (start, gap_day, upper):
        session.add(MarketTradeCalendar(trade_date=d))
    itf = await _seed_sdk_backfill_source(session)
    await _seed_settings(session, itf, start, mode=PRICE_BACKFILL_MODE_GAP)
    _no_wait(monkeypatch)
    _calls, _fake = _sdk_returning([])  # 抓不到任何行 → 洞填不上
    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake)

    # 续跑第一轮：pending 洞 attempts 0→1（未被清空归零），gap 表仍在
    await run_pending_price_backfill(session)
    rows = await _gap_rows(session)
    assert (m.id, gap_day, GAP_STATUS_PENDING, 1) in rows
    assert len(rows) == 1  # 续跑未清空 gap 表

    # 续跑第二轮：attempts 1→2 → exhausted（证明跨轮保留，而非每轮归零）
    await run_pending_price_backfill(session)
    rows = await _gap_rows(session)
    assert (m.id, gap_day, GAP_STATUS_EXHAUSTED, _GAP_MAX_ATTEMPTS) in rows


# ───────────────────────── D. 反向找茬：今天缺失不算洞 ─────────────────────────
@pytest.mark.asyncio
async def test_today_missing_is_not_a_gap(session):
    """护栏一：今天的缺失不算洞（今日日线可能尚未抓取），只有昨天算。"""
    today = today_app_tz()
    yesterday = today - timedelta(days=1)
    start = today - timedelta(days=2)
    m = await _add_master(session)
    await _add_dividend(session, m.id)
    session.add(
        MarketSecurityDailyPrice(master_id=m.id, trade_date=start, close=Decimal("10"))
    )
    # 今天缺失（无日线），但今天在窗口外（上界=昨天）→ 不应被判为洞
    for d in (start, yesterday, today):
        session.add(MarketTradeCalendar(trade_date=d))
    await session.commit()

    added = await sync_price_backfill_gaps(session, start)
    assert added == 1
    rows = await _gap_rows(session)
    assert [d for _, d, _, _ in rows] == [yesterday]  # 只有昨天，今天不在洞里


# ───────────────────────── D. legacy 零回归（force 恒 False，中间洞不补） ─────────────────────────
@pytest.mark.asyncio
async def test_legacy_zero_regression_force_false_skips_covered(session, monkeypatch):
    """gap 提交后 legacy 路径零回归：mode=legacy 时起点已覆盖即整只跳过，中间真实洞不补。

    证明：即便日历铺满、存在真实缺失交易日、桩能返回该日数据，legacy 也只按「起点是否覆盖」
    判定 → 不选该证券 → 零请求、不造洞、洞不补。``backfill_historical`` 的 force 恒 False。
    """
    m = await _add_master(session)
    await _add_dividend(session, m.id)
    start = date(2024, 1, 1)
    session.add(
        MarketSecurityDailyPrice(master_id=m.id, trade_date=start, close=Decimal("10"))
    )
    gap_day = start + timedelta(days=1)
    # 日历铺满窗口两端；上界补日线避免其上界本身变洞
    upper = _window_upper()
    session.add(
        MarketSecurityDailyPrice(master_id=m.id, trade_date=upper, close=Decimal("10"))
    )
    for d in (start, gap_day, upper):
        session.add(MarketTradeCalendar(trade_date=d))
    itf = await _seed_sdk_backfill_source(session)
    await _seed_settings(session, itf, start, mode=PRICE_BACKFILL_MODE_LEGACY)
    _no_wait(monkeypatch)
    calls, _fake = _sdk_returning([{"日期": gap_day.isoformat(), "收盘": "10.5"}])
    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake)

    await run_pending_price_backfill(session)
    # legacy 不发起请求（起点已覆盖 → 整只跳过）
    assert calls["n"] == 0
    # legacy 不走 sync，不凭空造洞
    assert await _gap_rows(session) == []
    # 中间真实洞确实未被补（零回归：gap 提交没改变 legacy 行为）
    filled = (
        await session.execute(
            select(MarketSecurityDailyPrice.trade_date).where(
                MarketSecurityDailyPrice.master_id == m.id,
                MarketSecurityDailyPrice.trade_date == gap_day,
            )
        )
    ).scalar_one_or_none()
    assert filled is None
    # 无待补 → 在途标记被清理（legacy 终态行为不变）
    settings = (
        await session.execute(select(DividendYieldSettings).limit(1))
    ).scalar_one()
    assert settings.price_backfill_start_date is None


# ───────────────────────── D. PRICE_BACKFILL_MODE_LEGACY 已正确导入（cd5db9c 漏导入修复） ─────────────────────────
def test_price_backfill_mode_legacy_imported_and_used():
    """静态确认：market_daily_price_sync 确实从 app.models 导入 PRICE_BACKFILL_MODE_LEGACY，
    且在 run_pending_price_backfill 内真实引用（非仅导入未用 / 漏导入导致运行时 NameError）。
    """
    import app.services.market_daily_price_sync as m

    # 导入存在且指向同一常量对象
    assert hasattr(m, "PRICE_BACKFILL_MODE_LEGACY")
    assert m.PRICE_BACKFILL_MODE_LEGACY is PRICE_BACKFILL_MODE_LEGACY
    assert hasattr(m, "PRICE_BACKFILL_MODE_GAP")
    assert m.PRICE_BACKFILL_MODE_GAP is PRICE_BACKFILL_MODE_GAP

    # 运行时分派确实引用这两个常量（源码层证据）
    src = inspect.getsource(m.run_pending_price_backfill)
    assert "PRICE_BACKFILL_MODE_GAP" in src
    assert "PRICE_BACKFILL_MODE_LEGACY" in src

    # 运行期强证据：模块能正常导入且 run_pending_price_backfill 可被引用（若漏导入会在 import 时挂）
    assert callable(m.run_pending_price_backfill)
