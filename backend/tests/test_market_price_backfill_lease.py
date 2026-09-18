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

from app.models import (
    DividendYieldSettings,
    MarketSecurityDailyPrice,
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
    run_pending_price_backfill,
)
from app.services.market_price_backfill_engine import backfill_historical
from app.services.market_price_backfill_lease import (
    AbortSummary,
    _abort_summary,
    _acquire_backfill_lease,
)



def _uid() -> str:
    return str(uuid.uuid4())


# ───────────────────────── 回补常量（决策 A15 / 附录 A.11） ─────────────────────────

async def _add_master(session, code="600000"):
    norm = _normalize_master_code(code, infer_exchange(code))
    m = Security(id=_uid(), code=norm, name="浦发银行", asset_class=SecurityType.STOCK)
    session.add(m)
    await session.flush()
    return m


# ───────────────────────── 双防线之防线一（决策 A9 主） ─────────────────────────

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
    session.add(DividendYieldSettings(
                                      price_source_interface_id=itf.id))
    return itf



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
        "app.services.market_price_backfill_engine._BACKFILL_BACKOFFS", (0,)
    )
    # 阈值压到 3，便于秒级验证熔断点
    monkeypatch.setattr(
        "app.services.market_price_backfill_engine._BACKFILL_FAILURE_BREAKER", 3
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
        "app.services.market_price_backfill_engine._BACKFILL_BACKOFFS", (0,)
    )
    monkeypatch.setattr(
        "app.services.market_price_backfill_engine._BACKFILL_FAILURE_BREAKER", 3
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
        "app.services.market_price_backfill_engine._BACKFILL_BACKOFFS", (0,)
    )
    monkeypatch.setattr(
        "app.services.market_price_backfill_engine._BACKFILL_FAILURE_BREAKER", 3
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
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_BACKOFFS", (0,))
    monkeypatch.setattr(
        "app.services.market_price_backfill_engine._BACKFILL_FAILURE_BREAKER", 3
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
@pytest.mark.parametrize("new_token", [None, "REPLACED-TOKEN"])
async def test_backfill_aborts_when_run_token_invalidated(
    session, monkeypatch, new_token
):
    """取消要真能停：世代标记失效（被取消 → NULL / 被新一次触发取代 → 新值）后，
    回补须在**下一只证券开始前**优雅中止——不再抓取剩余证券、不抛异常。

    这是「点了取消，界面显示已停、后台却又跑了几小时」的修复：此前取消只清在途标记，
    而循环从不复查，会把整个 pending（上限 = 当日剩余额度，可达 1000 只）跑完。
    """
    masters = [await _add_master(session, code=f"600{300 + i}") for i in range(3)]
    itf = await _seed_sdk_quote_source(session)
    settings = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    settings.price_backfill_run_token = "ORIGINAL-TOKEN"
    await session.commit()

    calls: list[str] = []

    async def _fake_sdk(self, itf_obj, params, codes):
        calls.append(params["symbol"])
        if len(calls) == 1:
            # 抓完第 1 只后模拟「用户在别处点了取消（NULL）」或「重新触发（新 UUID）」
            cur = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
            cur.price_backfill_run_token = new_token
            await session.commit()
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_BACKOFFS", (0,))

    msg = await backfill_historical(
        session, itf, [m.id for m in masters], date(2024, 1, 1),
        force=True, run_token="ORIGINAL-TOKEN",
    )
    # 只抓第 1 只即中止（剩余 2 只不再抓取）；中止是优雅返回、不是异常
    assert calls == ["600300"]
    assert "已中止" in msg



@pytest.mark.asyncio
async def test_backfill_ignores_cancellation_without_run_token(session, monkeypatch):
    """非在途链路（``run_token=None``，如定时任务按 ``backfill_start`` 参数直接调用）
    **不做**取消判定：即便库里的世代标记被改写也要全量跑完（零行为变更）。
    """
    masters = [await _add_master(session, code=f"600{310 + i}") for i in range(3)]
    itf = await _seed_sdk_quote_source(session)
    settings = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    settings.price_backfill_run_token = "ORIGINAL-TOKEN"
    await session.commit()

    calls: list[str] = []

    async def _fake_sdk(self, itf_obj, params, codes):
        calls.append(params["symbol"])
        if len(calls) == 1:
            cur = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
            cur.price_backfill_run_token = None  # 模拟被取消
            await session.commit()
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_BACKOFFS", (0,))

    msg = await backfill_historical(
        session, itf, [m.id for m in masters], date(2024, 1, 1), force=True,
    )
    assert len(calls) == 3  # 未传 run_token → 不检查 → 三只都抓
    assert "已中止" not in msg


# ───────── 执行租约：同一时刻只允许一个 run（防同日起跑重叠） ─────────

async def _seed_backfill_run(session):
    """造 SDK 回补源 + 在途标记 + 待回补证券（供租约用例复用）。"""
    provider = SecuritiesDataProvider(
        id=_uid(), name="akshare", access_method=QuoteProviderAccessMethod.SDK,
        config={}, enabled=True,
    )
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID,
        name="东财历史", endpoint="stock_zh_a_hist", http_method="GET",
        enabled=True, priority=1, resp_code_field="代码", resp_price_field="收盘",
        response_parse={}, params={},
    )
    session.add(provider)
    await session.flush()
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    session.add(itf)
    m = await _add_master(session, code="600000")
    session.add(
        SecurityDividend(
            master_id=m.id, report_year=date(2023, 1, 1).year, report_quarter=4,
            period_type=ReportPeriodType.ANNUAL,
            cash_per_share=Decimal("1.0"), status=DividendStatus.PAID,
        )
    )
    await session.flush()
    session.add(
        DividendYieldSettings(
            price_source_interface_id=itf.id,
            price_backfill_source_interface_id=itf.id,
            price_backfill_start_date=date(2024, 1, 1),
            price_backfill_quota=10,
        )
    )
    await session.commit()



@pytest.mark.asyncio
async def test_run_pending_price_backfill_lease_blocks_concurrent(session, monkeypatch):
    """租约被占用 → 本次直接跳过、**不发任何请求**。

    修复「管理员手动首批尚未跑完 + 15:05 每日收盘价抓取又起一个 run」：settings 行锁
    在第一次 commit 就释放，拦不住；租约保证同一时刻只有一个 run 在抓同一池子。
    """
    await _seed_backfill_run(session)
    settings = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    settings.price_backfill_running = True  # 模拟已有 run 正在执行
    await session.commit()

    calls: list[str] = []

    async def _fake_sdk(self, itf_obj, params, codes):
        calls.append(params["symbol"])
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_BACKOFFS", (0,))

    msg = await run_pending_price_backfill(session)
    assert "已有回补任务正在执行中" in msg
    assert calls == [], "抢不到租约不得发起任何抓取请求"



@pytest.mark.asyncio
async def test_acquire_backfill_lease_waits_for_release(session):
    """「取消 → 立刻重新触发」：老任务要跑到下一个取消检查点才释放租约，等待应当能等到。

    有界等待是**手动首批**专用（路由传 ``_BACKFILL_LEASE_WAIT_SECONDS``）：不等会让新首批
    命中「租约占用」直接跳过 → 当天什么都不跑、要等次日 15:05 续跑。
    """
    from app.db.database import AsyncSessionLocal  # 取 conftest 已 patch 的 sessionmaker

    await _seed_backfill_run(session)
    settings = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    settings.price_backfill_running = True  # 模拟老任务仍占用
    await session.commit()

    # 无等待：立刻返回 False（保持「抢不到即跳过」的原语义）
    assert await _acquire_backfill_lease(session) is False

    async def _release_later() -> None:
        await asyncio.sleep(0.3)  # 模拟老任务跑到下一个检查点后中止
        async with AsyncSessionLocal() as s2:
            await s2.execute(
                text("UPDATE dividend_yield_settings SET price_backfill_running = false")
            )
            await s2.commit()

    releaser = asyncio.create_task(_release_later())
    try:
        assert await _acquire_backfill_lease(session, timeout=5.0) is True
    finally:
        await releaser



@pytest.mark.asyncio
async def test_run_pending_price_backfill_lease_released_on_success_and_breaker(
    session, monkeypatch
):
    """租约必须在**成功**与**熔断**两条路径都释放，否则此后所有回补被永久挡住。"""
    await _seed_backfill_run(session)

    async def _ok(self, itf_obj, params, codes):
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _ok)
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_BACKOFFS", (0,))
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_COOLDOWN_MIN", 0)
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_COOLDOWN_MAX", 0)

    await run_pending_price_backfill(session)
    cur = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    assert cur.price_backfill_running is False, "成功路径必须释放租约"

    # 熔断路径：连续失败达阈值即中止（RuntimeError 向上抛），finally 仍须释放租约
    cur.price_backfill_start_date = date(2024, 1, 1)
    cur.price_backfill_used_today = 0
    await session.commit()

    async def _always_fail(self, itf_obj, params, codes):
        raise RuntimeError("数据源定向拒连（模拟）")

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _always_fail)
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_FAILURE_BREAKER", 1)

    with pytest.raises(RuntimeError):
        await run_pending_price_backfill(session)
    cur2 = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    assert cur2.price_backfill_running is False, "熔断/异常路径也必须释放租约"


# ───── P2-1：协作式中止（取消 / 被新一次触发取代）**不推进** rebuild 游标 ─────

def test_abort_summary_is_str_subclass():
    """``AbortSummary`` 必须是 ``str`` 子类：返回值要能直接拼进任务结果串、被子串断言
    （既有调用方与用例零改动），同时让调用方据 ``isinstance`` 区分「中止 vs 完成」。"""
    a = _abort_summary(1, 2, 3)
    assert isinstance(a, AbortSummary)
    assert isinstance(a, str)  # 可直接当字符串用
    assert "已中止" in a


# 比任何真实 UUID 都小的哨兵（hex 全零）：既能被 ``master_id > cursor`` 全选，又便于断言
# 「游标未被改写」——若中止路径误推进，游标会变成 pending[-1] 而非此哨兵。

@pytest.mark.asyncio
async def test_run_backfill_skips_when_lease_held(session, monkeypatch):
    """P2-2 回归：租约被占时 ``backfill_start`` 入口**跳过且不进入 backfill_historical**
    （手动首批在跑时，配了 backfill_start 的定时任务不得并发抓同一池子、额度双计）；
    且**不得**释放他人的租约（抢不到就不该动它，否则会拆掉正在跑的 run 的保护）。"""
    itf = await _seed_sdk_quote_source(session)
    m = await _add_master(session, code="600500")
    settings = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    settings.price_backfill_running = True  # 模拟已有 run 持租约
    await session.commit()

    entered: list[str] = []

    async def _should_not_enter(*args, **kwargs):
        entered.append("called")
        raise AssertionError("租约被占时不得进入 backfill_historical")

    monkeypatch.setattr(
        "app.services.market_price_backfill_engine.backfill_historical", _should_not_enter
    )

    svc = MarketDailyPriceSyncService(session)
    msg = await svc._run_backfill(itf, {"600500": m.id}, "2023-01-01")

    assert entered == [], "抢不到租约不得进入回补执行"
    assert "跳过" in msg and "已有回补任务正在执行中" in msg
    session.expire_all()
    cur = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    assert cur.price_backfill_running is True, "抢不到租约时不得释放他人的租约"



@pytest.mark.asyncio
async def test_run_backfill_runs_when_lease_free_and_releases(session, monkeypatch):
    """P2-2 回归：租约空闲时 ``backfill_start`` 入口正常执行（返回值透传），
    且执行完**释放**租约（否则此后所有回补被永久挡住）。"""
    itf = await _seed_sdk_quote_source(session)
    m = await _add_master(session, code="600501")
    await session.commit()

    calls: list[str] = []

    async def _record(*args, **kwargs):
        calls.append("called")
        return "历史回补完成（桩）"

    monkeypatch.setattr(
        "app.services.market_price_backfill_engine.backfill_historical", _record
    )

    svc = MarketDailyPriceSyncService(session)
    msg = await svc._run_backfill(itf, {"600501": m.id}, "2023-01-01")

    assert calls == ["called"], "租约空闲时必须真的执行回补"
    assert msg == "历史回补完成（桩）"
    session.expire_all()
    cur = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    assert cur.price_backfill_running is False, "执行完毕必须释放租约"



@pytest.mark.asyncio
async def test_run_backfill_releases_lease_on_error(session, monkeypatch):
    """P2-2 回归：``backfill_start`` 入口执行中抛错（熔断 / 接口不可达）时租约**仍须释放**。"""
    itf = await _seed_sdk_quote_source(session)
    m = await _add_master(session, code="600502")
    await session.commit()

    async def _boom(*args, **kwargs):
        raise RuntimeError("熔断（模拟）")

    monkeypatch.setattr("app.services.market_price_backfill_engine.backfill_historical", _boom)

    svc = MarketDailyPriceSyncService(session)
    with pytest.raises(RuntimeError, match="熔断"):
        await svc._run_backfill(itf, {"600502": m.id}, "2023-01-01")

    session.expire_all()
    cur = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    assert cur.price_backfill_running is False, "异常路径也必须释放租约"


# ───── P2-1 残余窗口加固：收尾期间（最后一只抓取中）世代标记失效 → 仍不推进游标 ─────
# 背景（QA 对抗验证报告 §3）：三个取消检查点覆盖不到「取消恰好落在最后一只证券抓取期间」——
# ①在「每只开始前」（那时尚未取消）、②只在退避 sleep 之后（成功不经过）、③只在批间冷却
# （最后一批之后无下一批）——于是 backfill_historical 走正常完成分支、返回普通 str。
# 加固：推进游标前**二次校验世代标记**（非中止 且 标记仍有效才推进）。
