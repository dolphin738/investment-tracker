"""历史行情回补「严格补洞（gap）」模式单测（迁移 0021）。

守护的语义与护栏：
- legacy 口径只看「起点是否覆盖」，起点一覆盖就整只永久跳过 → **中间空洞永不回填**；
  gap 模式改为按交易日历逐日比对，把缺失交易日落成洞并重新纳入批次。
- 护栏一：**上界 = 昨天**（今天的日线可能还没抓，算洞会让任务永不结束）。
- 护栏二：**attempts ≥ 2 → exhausted**（数据源长期无某日数据时不再重复白烧额度）。
- 护栏三：**交易日历不覆盖回补窗口 → 回落 legacy**（无从判定哪些日子该有数据，
  不能静默空转、更不能误判成「没有洞 → 补完」）。
- 配置面：``price_backfill_mode`` 值域 legacy|gap，越界 400。

全部走真实 Postgres 测试库（conftest 自动建表），网络层用 monkeypatch 打桩。
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy import update as sa_update

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
    User,
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
    _select_gap_backfill_masters,
    run_pending_price_backfill,
    sync_price_backfill_gaps,
)
from tests.helpers import auth, env, register_login


def _uid() -> str:
    return str(uuid.uuid4())


async def _add_master(session, code: str = "600000") -> Security:
    norm = _normalize_master_code(code, infer_exchange(code))
    m = Security(id=_uid(), code=norm, name="浦发银行", asset_class=SecurityType.STOCK)
    session.add(m)
    await session.flush()
    return m


async def _add_dividend(session, master_id: str) -> None:
    """把证券纳入回补池：``_select_pending_backfill_masters`` / gap sync 都以
    ``security_dividends.master_id`` 为全集。"""
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
    """造 sdk 接入的行情接口（回补源硬约束：分类 2 + enabled + access_method=sdk）。"""
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
    """造单行全局配置（回补源 + 在途起点 + 模式 + 额度）。"""
    row = DividendYieldSettings(
        green_threshold=Decimal("0.05"),
        red_threshold=Decimal("0.03"),
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
    """去掉回补的冷却与退避等待，让测试不必真睡几十秒。"""
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,))
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MIN", 0)
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MAX", 0)


def _sdk_returning(rows):
    """构造 ``MarketDataSyncService._fetch_sdk_raw`` 打桩，返回固定行并计数。"""
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


# ───────────────────────── ① 选中「有洞」的证券 ─────────────────────────
@pytest.mark.asyncio
async def test_gap_mode_selects_security_with_missing_trade_day(session):
    """守护 gap 核心语义：起点已覆盖（legacy 会跳过）但中间缺交易日 → 仍被选中。

    这正是 legacy 的盲区：``earliest <= start_date`` 成立即整只跳过，洞永不回填。
    """
    m = await _add_master(session)
    await _add_dividend(session, m.id)
    start = date(2024, 1, 1)
    # 起点已覆盖（有 start 当天日线）→ legacy 口径下该证券会被跳过
    session.add(MarketSecurityDailyPrice(master_id=m.id, trade_date=start, close=Decimal("10")))
    for d in (start, date(2024, 1, 2), date(2024, 1, 3)):
        session.add(MarketTradeCalendar(trade_date=d))
    await session.commit()

    masters, calendar_ok = await _select_gap_backfill_masters(session, start, 100)
    assert calendar_ok is True
    assert masters == [m.id]  # 起点已覆盖却仍被选中 —— legacy 做不到

    rows = await _gap_rows(session)
    assert [(mid, d) for mid, d, _, _ in rows] == [
        (m.id, date(2024, 1, 2)),
        (m.id, date(2024, 1, 3)),
    ]
    assert all(st == GAP_STATUS_PENDING and att == 0 for _, _, st, att in rows)


# ───────────────────────── ② 护栏一：上界 = 昨天 ─────────────────────────
@pytest.mark.asyncio
async def test_gap_mode_upper_bound_is_yesterday(session):
    """守护护栏一：今天的缺失不算洞（今日日线可能尚未抓取），昨天才算。"""
    today = today_app_tz()
    yesterday = today - timedelta(days=1)
    start = today - timedelta(days=2)
    m = await _add_master(session)
    await _add_dividend(session, m.id)
    session.add(MarketSecurityDailyPrice(master_id=m.id, trade_date=start, close=Decimal("10")))
    for d in (start, yesterday, today):
        session.add(MarketTradeCalendar(trade_date=d))
    await session.commit()

    added = await sync_price_backfill_gaps(session, start)
    assert added == 1
    rows = await _gap_rows(session)
    assert [d for _, d, _, _ in rows] == [yesterday]  # 今天不在洞里


# ───────────────────────── ③ 护栏二：attempts ≥ 2 → exhausted ─────────────────────────
@pytest.mark.asyncio
async def test_gap_mode_marks_exhausted_after_max_attempts(session, monkeypatch):
    """守护护栏二：同一批洞被尝试 2 次仍填不上 → exhausted 且不再入批。

    数据源（返回空）模拟「该日数据确实取不到」：继续重试只会每天重复消耗额度。
    """
    m = await _add_master(session)
    await _add_dividend(session, m.id)
    start = date(2024, 1, 1)
    session.add(MarketSecurityDailyPrice(master_id=m.id, trade_date=start, close=Decimal("10")))
    session.add(MarketTradeCalendar(trade_date=start))
    session.add(MarketTradeCalendar(trade_date=date(2024, 1, 2)))  # 洞
    itf = await _seed_sdk_backfill_source(session)
    await _seed_settings(session, itf, start)
    _no_wait(monkeypatch)
    calls, _fake = _sdk_returning([])  # 抓不到任何行 → 洞永远填不上
    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake)

    await run_pending_price_backfill(session)
    rows = await _gap_rows(session)
    assert [(r[2], r[3]) for r in rows] == [(GAP_STATUS_PENDING, 1)]

    await run_pending_price_backfill(session)
    rows = await _gap_rows(session)
    assert [(r[2], r[3]) for r in rows] == [(GAP_STATUS_EXHAUSTED, _GAP_MAX_ATTEMPTS)]

    # 第三次：洞已 exhausted → 无待补 → 补完、清在途标记（终态）
    calls["n"] = 0
    msg = await run_pending_price_backfill(session)
    assert calls["n"] == 0
    settings = (
        await session.execute(select(DividendYieldSettings).limit(1))
    ).scalar_one()
    assert settings.price_backfill_start_date is None
    assert "完成" in msg


# ───────────────────────── ④ 护栏三：日历不覆盖 → 回落 legacy ─────────────────────────
@pytest.mark.asyncio
async def test_gap_mode_falls_back_to_legacy_when_calendar_missing(session, monkeypatch):
    """守护护栏三：日历不覆盖回补窗口 → sync 返回 None，本轮回落 legacy 而非静默空转。

    判据：日历为空时 gap 无法判定洞（应 0 个洞行），但证券仍被处理（legacy 选中了
    完全未覆盖的它）——若 gap 分支硬走，本例会零请求且任务被误判成「补」。
    """
    m = await _add_master(session)
    await _add_dividend(session, m.id)
    start = date(2024, 1, 1)
    itf = await _seed_sdk_backfill_source(session)
    await _seed_settings(session, itf, start)
    _no_wait(monkeypatch)
    calls, _fake = _sdk_returning([{"日期": "2024-01-02", "收盘": "10.5"}])
    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake)

    # 日历为空 → sync 无从判定
    assert await sync_price_backfill_gaps(session, start) is None

    msg = await run_pending_price_backfill(session)
    assert calls["n"] == 1  # 回落后仍处理了该证券（legacy 口径：完全未覆盖）
    assert await _gap_rows(session) == []  # gap 分支没有凭空造洞
    settings = (
        await session.execute(select(DividendYieldSettings).limit(1))
    ).scalar_one()
    assert settings.price_backfill_start_date == start  # 未被误判为「补完」


# ───────────────────────── ⑤ 配置值域校验（PUT /settings） ─────────────────────────
async def _make_admin(session, client) -> dict:
    """注册用户并提升为 admin（require_admin 以 DB 实时 role 为准）。"""
    info = await register_login(client, email="boss@example.com")
    await session.execute(
        sa_update(User).where(User.email == "boss@example.com").values(role="admin")
    )
    await session.commit()
    return info


@pytest.mark.asyncio
async def test_settings_put_backfill_mode_validation(session, client):
    """守护配置面：price_backfill_mode 越界 400 不落库；legacy/gap 可写、GET 可读回。"""
    admin = await _make_admin(session, client)
    h = auth(admin["token"])

    r = await client.put(
        "/api/dividend-yield/settings",
        json={
            "green_threshold": "0.05",
            "red_threshold": "0.03",
            "price_backfill_mode": "bogus",
        },
        headers=h,
    )
    status, _code, _data, message = env(r)
    assert status == 400
    assert "legacy" in (message or "")

    r = await client.put(
        "/api/dividend-yield/settings",
        json={
            "green_threshold": "0.05",
            "red_threshold": "0.03",
            "price_backfill_mode": PRICE_BACKFILL_MODE_GAP,
        },
        headers=h,
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["price_backfill_mode"] == PRICE_BACKFILL_MODE_GAP

    r = await client.get("/api/dividend-yield/settings", headers=h)
    assert r.status_code == 200
    assert r.json()["data"]["price_backfill_mode"] == PRICE_BACKFILL_MODE_GAP

    # 切回 legacy 亦可（往返可切）
    r = await client.put(
        "/api/dividend-yield/settings",
        json={
            "green_threshold": "0.05",
            "red_threshold": "0.03",
            "price_backfill_mode": PRICE_BACKFILL_MODE_LEGACY,
        },
        headers=h,
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["price_backfill_mode"] == PRICE_BACKFILL_MODE_LEGACY


# ───────────────────────── ⑥ 补上即删 + 终态清标记 ─────────────────────────
@pytest.mark.asyncio
async def test_gap_mode_reconciles_filled_gaps_and_clears_inflight(session, monkeypatch):
    """守护「洞即数据」：洞被填上即删除；全部补齐后清在途标记（终态，不再空转）。"""
    m = await _add_master(session)
    await _add_dividend(session, m.id)
    start = date(2024, 1, 1)
    session.add(MarketSecurityDailyPrice(master_id=m.id, trade_date=start, close=Decimal("10")))
    session.add(MarketSecurityDailyPrice(master_id=m.id, trade_date=date(2024, 1, 2), close=Decimal("10")))
    for d in (start, date(2024, 1, 2), date(2024, 1, 3)):
        session.add(MarketTradeCalendar(trade_date=d))
    itf = await _seed_sdk_backfill_source(session)
    await _seed_settings(session, itf, start)
    _no_wait(monkeypatch)
    calls, _fake = _sdk_returning([{"日期": "2024-01-03", "收盘": "10.5"}])
    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake)

    # 第一轮：force 重抓 → 补上 2024-01-03 → reconcile 删掉已填的洞
    await run_pending_price_backfill(session)
    assert calls["n"] == 1
    filled = (
        await session.execute(
            select(MarketSecurityDailyPrice.trade_date).where(
                MarketSecurityDailyPrice.master_id == m.id,
                MarketSecurityDailyPrice.trade_date == date(2024, 1, 3),
            )
        )
    ).scalar_one_or_none()
    assert filled == date(2024, 1, 3)  # 洞确实被补上
    assert await _gap_rows(session) == []  # 补上即删，不留终态

    # 第二轮：无洞可补 → 清在途标记、零请求
    calls["n"] = 0
    msg = await run_pending_price_backfill(session)
    assert calls["n"] == 0
    settings = (
        await session.execute(select(DividendYieldSettings).limit(1))
    ).scalar_one()
    assert settings.price_backfill_start_date is None
    assert "完成" in msg


# ───────────── ⑦ 起始日期收紧：窗口外陈旧洞被清理 ─────────────
@pytest.mark.asyncio
async def test_gap_mode_prunes_stale_gaps_outside_window(session):
    """守护窗口语义：起始日期收紧后，早于新起点的陈旧洞行必须被删除。

    否则「只剩陈旧洞」的证券会在每轮被判待补 → 白烧额度、并在 attempts 达阈值后被
    无谓置 exhausted（真实洞反而再也补不上）；起始日期可配后这是必然出现的场景。
    """
    m = await _add_master(session)
    await _add_dividend(session, m.id)
    new_start = date(2024, 2, 1)
    # 新起点已覆盖，且新窗口内每个交易日都有日线 → 收紧后应判定「无洞」
    for d in (new_start, date(2024, 2, 2)):
        session.add(
            MarketSecurityDailyPrice(master_id=m.id, trade_date=d, close=Decimal("10"))
        )
        session.add(MarketTradeCalendar(trade_date=d))
    # 陈旧洞行：属于更早窗口（新起点之前）
    session.add(
        MarketPriceBackfillGap(
            master_id=m.id,
            gap_date=date(2024, 1, 5),
            status=GAP_STATUS_PENDING,
            attempts=0,
        )
    )
    await session.commit()
    assert [r[1] for r in await _gap_rows(session)] == [date(2024, 1, 5)]

    synced = await sync_price_backfill_gaps(session, new_start)
    await session.commit()

    assert synced == 0  # 新窗口内无洞
    assert await _gap_rows(session) == []  # 陈旧洞已被窗口清理删除
    masters, calendar_ok = await _select_gap_backfill_masters(session, new_start, 100)
    assert calendar_ok is True
    assert masters == []  # 不会仅因陈旧洞而被选中
