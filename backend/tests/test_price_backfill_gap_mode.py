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


def _window_upper() -> date:
    """回补窗口上界（护栏一：上界 = 昨天）。

    护栏三要求日历覆盖窗口**两端**（``<= start`` 且 ``>= 上界``）；既有用例的日历原只
    铺到窗口内的某几天，在「只判窗口内任意一天」的旧判据下能通过、在两端判据下会判为
    「上界未覆盖」，故这些用例须显式补一行上界交易日。
    """
    return today_app_tz() - timedelta(days=1)


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
    # 护栏三（两端覆盖）：日历须覆盖窗口下界（<= start）与上界（>= 昨天）；故除窗口内交易日
    # 外，还需补一行上界交易日（并为其补日线，避免它本身变成洞、污染断言）。
    upper = _window_upper()
    session.add(MarketSecurityDailyPrice(master_id=m.id, trade_date=upper, close=Decimal("10")))
    for d in (start, date(2024, 1, 2), date(2024, 1, 3), upper):
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
    # 护栏三（两端覆盖）：补一行上界交易日并为其补日线（避免上界本身变成洞）
    upper = _window_upper()
    session.add(MarketSecurityDailyPrice(master_id=m.id, trade_date=upper, close=Decimal("10")))
    session.add(MarketTradeCalendar(trade_date=upper))
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

    await run_pending_price_backfill(session)
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


# ─────────────── 日期字段「显式提交」语义 + 配置组合校验 ───────────────
@pytest.mark.asyncio
async def test_settings_put_explicit_null_clears_dates(session, client):
    """守护修复：两个日期字段改为「显式提交」语义——显式 null = 清除（恢复默认）。

    旧口径（None = 不改）会让「用户清空日期想恢复默认」保存无效（前端 watch 又回填
    旧值），与「回补起始日期无法保存」的原始缺陷同源。修复后：显式提供（含 null）即
    覆盖；未提供 = 不改（见下一条测试）。
    """
    admin = await _make_admin(session, client)
    h = auth(admin["token"])
    base = {"green_threshold": "0.05", "red_threshold": "0.03"}

    # 先各设一个日期
    r = await client.put(
        "/api/dividend-yield/settings",
        json={
            **base,
            "price_backfill_default_start_date": "2024-01-01",
            "trade_calendar_start_date": "2024-01-01",
        },
        headers=h,
    )
    assert r.status_code == 200

    # 显式 null → 清除（GET 回 null）
    r = await client.put(
        "/api/dividend-yield/settings",
        json={
            **base,
            "price_backfill_default_start_date": None,
            "trade_calendar_start_date": None,
        },
        headers=h,
    )
    assert r.status_code == 200
    r = await client.get("/api/dividend-yield/settings", headers=h)
    data = r.json()["data"]
    assert data["price_backfill_default_start_date"] is None
    assert data["trade_calendar_start_date"] is None


@pytest.mark.asyncio
async def test_settings_put_omitting_dates_keeps_value(session, client):
    """未提供（请求体不含该字段）= 不改：与「显式 null 清除」构成完整三态语义。"""
    admin = await _make_admin(session, client)
    h = auth(admin["token"])
    base = {"green_threshold": "0.05", "red_threshold": "0.03"}

    r = await client.put(
        "/api/dividend-yield/settings",
        json={**base, "trade_calendar_start_date": "2024-06-01"},
        headers=h,
    )
    assert r.status_code == 200

    # 不含该字段的保存（如只改阈值）不得清掉已存日期
    r = await client.put("/api/dividend-yield/settings", json=base, headers=h)
    assert r.status_code == 200
    r = await client.get("/api/dividend-yield/settings", headers=h)
    assert r.json()["data"]["trade_calendar_start_date"] == "2024-06-01"


@pytest.mark.asyncio
async def test_settings_put_rejects_calendar_start_after_backfill_start(session, client):
    """配置组合显性化：交易日历起始日期晚于回补起始日期 → 400 中文。

    该组合下日历覆盖不到回补窗口下界，gap 模式每轮静默回落 legacy（用户切了 gap
    却不生效只能靠后端日志发现）。校验用「提交后生效值」组合判断：显式提供用提交值，
    未提供用库中现值。
    """
    admin = await _make_admin(session, client)
    h = auth(admin["token"])
    base = {"green_threshold": "0.05", "red_threshold": "0.03"}

    # 场景 1：同一次 PUT 内组合越界
    r = await client.put(
        "/api/dividend-yield/settings",
        json={
            **base,
            "price_backfill_default_start_date": "2024-01-01",
            "trade_calendar_start_date": "2025-01-01",
        },
        headers=h,
    )
    status, _code, _data, message = env(r)
    assert status == 400
    assert "交易日历起始日期须不晚于回补起始日期" in (message or "")

    # 场景 2：库里已存回补起点 2024-01-01，本次只把日历起始改得更晚 → 生效值组合越界
    r = await client.put(
        "/api/dividend-yield/settings",
        json={**base, "price_backfill_default_start_date": "2024-01-01"},
        headers=h,
    )
    assert r.status_code == 200
    r = await client.put(
        "/api/dividend-yield/settings",
        json={**base, "trade_calendar_start_date": "2025-01-01"},
        headers=h,
    )
    status, _code, _data, _message = env(r)
    assert status == 400

    # 场景 3：合法组合（日历起始 <= 回补起点）应通过
    r = await client.put(
        "/api/dividend-yield/settings",
        json={
            **base,
            "price_backfill_default_start_date": "2024-01-01",
            "trade_calendar_start_date": "2024-01-01",
        },
        headers=h,
    )
    assert r.status_code == 200


# ─────────────── 建洞时也按 skip_exchange 过滤（与两条选批腿同口径） ───────────────
@pytest.mark.asyncio
async def test_sync_gaps_skips_excluded_exchange(session):
    """建洞时同样排除被跳过交易所（如腾讯源无京A → ``'BJ'``），并清理遗留的该类洞。

    此前只有两条**选批**腿（uncovered / gapped）过滤了该交易所，建洞 SQL 没有 → BJ 证券的
    洞会被永久创建又永远不入批（不 exhausted、也不影响「补完」判定），只是白占状态表。
    """
    start = date(2024, 1, 1)
    upper = _window_upper()
    sh = await _add_master(session, code="600001")
    sh.exchange = "SH"
    bj = await _add_master(session, code="830001")
    bj.exchange = "BJ"
    for m in (sh, bj):
        await _add_dividend(session, m.id)
        # 起点已覆盖 → 进入「洞」的池子（护栏二）
        session.add(
            MarketSecurityDailyPrice(
                master_id=m.id, trade_date=start, close=Decimal("10")
            )
        )
    # 日历覆盖窗口两端；窗口内 01-02 / 01-03 缺日线 → 对两只都是洞
    for d in (start, date(2024, 1, 2), date(2024, 1, 3), upper):
        session.add(MarketTradeCalendar(trade_date=d))
    await session.commit()

    # 对照组：不传 skip_exchange 时两只都记洞（证明池子本身包含 BJ）
    await sync_price_backfill_gaps(session, start)
    assert {r[0] for r in await _gap_rows(session)} == {sh.id, bj.id}

    # 传 'BJ'：既有 BJ 洞被清理，且不再新建（SH 的洞已存在 → 无新增）
    added = await sync_price_backfill_gaps(session, start, skip_exchange="BJ")
    assert added == 0
    assert {r[0] for r in await _gap_rows(session)} == {sh.id}


# ───────────────────────── ⑥ 补上即删 + 终态清标记 ─────────────────────────
@pytest.mark.asyncio
async def test_gap_mode_reconciles_filled_gaps_and_clears_inflight(session, monkeypatch):
    """守护「洞即数据」：洞被填上即删除；全部补齐后清在途标记（终态，不再空转）。"""
    m = await _add_master(session)
    await _add_dividend(session, m.id)
    start = date(2024, 1, 1)
    session.add(MarketSecurityDailyPrice(master_id=m.id, trade_date=start, close=Decimal("10")))
    session.add(MarketSecurityDailyPrice(master_id=m.id, trade_date=date(2024, 1, 2), close=Decimal("10")))
    # 护栏三（两端覆盖）：补一行上界交易日并为其补日线（避免上界本身变成洞）
    upper = _window_upper()
    session.add(MarketSecurityDailyPrice(master_id=m.id, trade_date=upper, close=Decimal("10")))
    for d in (start, date(2024, 1, 2), date(2024, 1, 3), upper):
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
    # 新起点已覆盖，且新窗口内每个交易日都有日线 → 收紧后应判定「无洞」。
    # 护栏三（两端覆盖）：窗口内日历须覆盖下界（<= new_start）与上界（>= 昨天）；
    # 故除窗口内交易日外补一行上界交易日，并为其补日线（避免它本身变成洞）。
    upper = _window_upper()
    for d in (new_start, date(2024, 2, 2), upper):
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


# ───────────── ⑧ 护栏三（两端覆盖）：下界未覆盖 → None ─────────────
@pytest.mark.asyncio
async def test_gap_mode_returns_none_when_lower_bound_not_covered(session):
    """护栏三（两端覆盖）：日历未覆盖窗口**下界**（无 ``trade_date <= start``）→ None 回落 legacy。

    构造：仅铺窗口上界那一行（``>= 上界`` 成立），但没有任何 ``<= start`` 的行 → 下界未覆盖。
    旧判据（窗口内任意一天在日历里）会误判为「已覆盖」而继续判定，故本用例是真回归守护。
    """
    m = await _add_master(session)
    await _add_dividend(session, m.id)
    start = date(2024, 1, 1)
    upper = _window_upper()
    session.add(MarketTradeCalendar(trade_date=upper))  # 仅覆盖上界，不覆盖下界
    await session.commit()

    assert await sync_price_backfill_gaps(session, start) is None
    assert await _gap_rows(session) == []  # 无从判定 → 不落任何洞


# ───────────── ⑨ 护栏三（两端覆盖）：上界未覆盖 → None ─────────────
@pytest.mark.asyncio
async def test_gap_mode_returns_none_when_upper_bound_not_covered(session):
    """护栏三（两端覆盖）：日历未覆盖窗口**上界**（无 ``trade_date >= 昨天``）→ None 回落 legacy。

    构造：仅铺起点那一天（``<= start`` 成立），日历尾部在窗口结束前断层 → 上界未覆盖。
    这正是「部分覆盖静默漏判一整段」的真实场景：若按旧判据（窗口内任意一天）会误判为
    「已覆盖」，尾部整段「日历有、日线无」的交易日被漏判、任务还被误报成「补完」。
    """
    m = await _add_master(session)
    await _add_dividend(session, m.id)
    start = date(2024, 1, 1)
    session.add(MarketTradeCalendar(trade_date=start))  # 仅覆盖下界，不覆盖上界
    await session.commit()

    assert await sync_price_backfill_gaps(session, start) is None
    assert await _gap_rows(session) == []  # 无从判定 → 不落任何洞


# ───────────── ⑩ 窗口内的 exhausted 洞不被窗口清理 DELETE 掉 ─────────────
@pytest.mark.asyncio
async def test_gap_mode_keeps_in_window_exhausted_gap(session):
    """守护覆盖缺口：窗口清理 DELETE 只删**窗口外**（``gap_date < start`` 或 ``> 昨天``）的洞；
    窗口内的 exhausted 洞必须保留。

    否则它会被每轮 sync 删掉后以 pending 重新插入，「已放弃」状态形同虚设，停牌洞又会每天
    被重新选中白烧额度——与护栏二（attempts 达阈值不再重试）自相矛盾。
    """
    m = await _add_master(session)
    await _add_dividend(session, m.id)
    upper = _window_upper()
    start = upper - timedelta(days=3)
    # 日历覆盖窗口两端；起点有日线（纳入池），上界无日线
    session.add(MarketSecurityDailyPrice(master_id=m.id, trade_date=start, close=Decimal("10")))
    for d in (start, upper):
        session.add(MarketTradeCalendar(trade_date=d))
    # 窗口内的 exhausted 洞（位于上界）
    session.add(
        MarketPriceBackfillGap(
            master_id=m.id,
            gap_date=upper,
            status=GAP_STATUS_EXHAUSTED,
            attempts=_GAP_MAX_ATTEMPTS,
        )
    )
    await session.commit()

    synced = await sync_price_backfill_gaps(session, start)
    await session.commit()

    assert synced == 0  # (master, gap_date) 已存在 → 不新增
    # 窗口内 exhausted 洞未被 DELETE、也未被改回 pending
    assert await _gap_rows(session) == [
        (m.id, upper, GAP_STATUS_EXHAUSTED, _GAP_MAX_ATTEMPTS)
    ]


# ───────────── ⑪ 护栏：每日续跑不清空 gap 表、不重置 attempts ─────────────
@pytest.mark.asyncio
async def test_daily_continuation_does_not_clear_gap_state(session, monkeypatch):
    """护栏：每日续跑（``run_pending_price_backfill``）**绝不清空** gap 表、也不重置 attempts。

    清空只允许发生在路由层的「重新触发 / 取消」两处（与在途标记同事务）。若续跑里也清，
    attempts 会每天归零 → 停牌洞永远循环（活锁），护栏二（达阈值不再重试）形同虚设。
    本用例：留一个 pending 洞（续跑后 attempts 应 0→1，而非被清空归零）+ 一个 exhausted 洞
    （续跑后应保持 exhausted），二者都必须在续跑后仍在表内。
    """
    m = await _add_master(session)
    await _add_dividend(session, m.id)
    upper = _window_upper()
    start = upper - timedelta(days=3)
    mid = start + timedelta(days=1)
    # 日历覆盖窗口两端；仅起点有日线（纳入池）→ mid/upper 为洞
    session.add(MarketSecurityDailyPrice(master_id=m.id, trade_date=start, close=Decimal("10")))
    for d in (start, mid, upper):
        session.add(MarketTradeCalendar(trade_date=d))
    # 预置一个已达阈值的 exhausted 洞（位于上界）
    session.add(
        MarketPriceBackfillGap(
            master_id=m.id,
            gap_date=upper,
            status=GAP_STATUS_EXHAUSTED,
            attempts=_GAP_MAX_ATTEMPTS,
        )
    )
    itf = await _seed_sdk_backfill_source(session)
    await _seed_settings(session, itf, start)
    _no_wait(monkeypatch)
    _calls, _fake = _sdk_returning([])  # 抓不到任何行 → 洞填不上
    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake)

    await run_pending_price_backfill(session)

    rows = await _gap_rows(session)
    # pending 洞 attempts 递增（未被清空归零）；exhausted 洞保持 exhausted
    assert (m.id, mid, GAP_STATUS_PENDING, 1) in rows
    assert (m.id, upper, GAP_STATUS_EXHAUSTED, _GAP_MAX_ATTEMPTS) in rows
