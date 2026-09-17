"""交易日历刷新独立系统任务单测（§5.5 防线一 / §7 stale 基准）。

守护本次拆分：把原先「只在五年留存清理里顺带刷新」的交易日历刷新，拆成独立系统定时任务
``TRADE_CALENDAR_REFRESH``，使 ``market_trade_calendar`` 表稳定被填充。覆盖：

- handler 在调度器注册表 ``_HANDLERS`` 中存在且指向 ``run_trade_calendar_refresh``；
- 迁移已把 ``TRADE_CALENDAR_REFRESH`` 写入原生枚举（用 INSERT 隐含校验）；
- handler 正常路径返回含「交易日历刷新完成」的摘要（monkeypatch 注入一行日历）；
- handler 在日历**仍为空**时抛 ``RuntimeError``（把 refresh 内部吞掉的失败显性化 → FAILED）。
"""
from __future__ import annotations

import importlib.util
import sys
import types
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pytest
import sqlalchemy as sa
from sqlalchemy import func, select

import app.services.dividend_yield_refresh as dyf
from app.core.date_utils import today_app_tz
from app.models import DividendYieldSettings, JobConfig, MarketTradeCalendar
from app.models.enums import JobKind, JobTaskType
from app.services.dividend_yield_refresh import (
    TradeCalendarRefresh,
    refresh_trade_calendar,
    run_trade_calendar_refresh,
)
from app.services.scheduler import _HANDLERS


def _stub_cfg() -> types.SimpleNamespace:
    return types.SimpleNamespace(
        task_type=JobTaskType.TRADE_CALENDAR_REFRESH, params={}
    )


def test_handler_registered() -> None:
    """守护：调度器注册表薄注册该任务类型 → handler。"""
    assert _HANDLERS.get(JobTaskType.TRADE_CALENDAR_REFRESH) is run_trade_calendar_refresh


@pytest.mark.asyncio
async def test_enum_value_accepted_by_db(session) -> None:
    """守护迁移 0019：``TRADE_CALENDAR_REFRESH`` 已加入原生 ``JobTaskType`` 枚举。

    直接以该枚举值 INSERT 一行 ``job_configs``——若枚举值缺失，PG 会在 flush 时报
    ``invalid input value for enum``，本用例即构成迁移护栏（表体由 _clean_db 预先清空，
    故不依赖种子行；这里验的是枚举类型本身）。
    """
    cfg = JobConfig(
        name="trade-calendar-enum-probe",
        kind=JobKind.SYSTEM,
        task_type=JobTaskType.TRADE_CALENDAR_REFRESH,
        cron_expr="0 8 * * *",
        enabled=True,
        params={},
    )
    session.add(cfg)
    await session.flush()  # 枚举值缺失则此处抛错
    await session.rollback()


@pytest.mark.asyncio
async def test_handler_success_summary(session, monkeypatch) -> None:
    """守护正常路径：刷新后表非空 → 返回含「交易日历刷新完成」+ 计数 + 最新日的摘要。"""

    async def _fake_refresh(
        sess, *, full: bool = False, start_date: date | None = None
    ) -> TradeCalendarRefresh:  # noqa: ARG001
        sess.add(MarketTradeCalendar(trade_date=date(2025, 3, 3)))
        sess.add(MarketTradeCalendar(trade_date=date(2025, 3, 4)))
        return TradeCalendarRefresh(2, 2)  # 源 2 个交易日、写入 2 行

    monkeypatch.setattr(dyf, "refresh_trade_calendar", _fake_refresh)

    msg = await run_trade_calendar_refresh(_stub_cfg())

    assert "交易日历刷新完成" in msg
    assert "2" in msg  # 共 2 个交易日
    assert "2025-03-04" in msg  # 最新交易日
    # 落库确认：handler 会话已提交两行
    total = (
        await session.execute(select(MarketTradeCalendar.trade_date))
    ).scalars().all()
    assert set(total) == {date(2025, 3, 3), date(2025, 3, 4)}


@pytest.mark.asyncio
async def test_handler_raises_when_still_empty(session, monkeypatch) -> None:
    """守护兜底：refresh 声称成功（返回 >0）却一行未落、表为空 → 抛 RuntimeError。"""

    async def _fetch_ok_but_no_write(
        sess, *, full: bool = False, start_date: date | None = None
    ) -> TradeCalendarRefresh:  # noqa: ARG001
        return TradeCalendarRefresh(5, 0)  # 声称拉到 5 个交易日，但一行未落（异常态）

    monkeypatch.setattr(dyf, "refresh_trade_calendar", _fetch_ok_but_no_write)

    with pytest.raises(RuntimeError, match="交易日历刷新后仍为空"):
        await run_trade_calendar_refresh(_stub_cfg())


def _load_migration_0019():
    """按路径加载迁移 0019 模块（``alembic/versions`` 非包，故用 importlib）。"""
    path = (
        Path(__file__).resolve().parents[1]
        / "alembic"
        / "versions"
        / "0019_add_trade_calendar_refresh_task.py"
    )
    spec = importlib.util.spec_from_file_location("_mig_0019", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.asyncio
async def test_migration_seeds_trade_calendar_task_row(session) -> None:
    """守护迁移 0019 的**种子行写入**（QA 指出的覆盖缺口）。

    既有 4 个用例都验不到「种子行落库」——因为 conftest 的 ``_clean_db``（autouse）
    每个用例前 ``TRUNCATE`` 全表，会把 bootstrap 期由 ``alembic upgrade`` 种下的行清掉。
    此处直接复用迁移文件里的种子 SQL（``_SEED_SQL``，单一真相源，避免重复/漂移），断言：
    ① 落 1 行且关键字段正确（task_type/kind/enabled/cron）；② 幂等（再执行仍 1 行）。
    """
    mig = _load_migration_0019()
    stmt = sa.text(mig._SEED_SQL).bindparams(name=mig._TASK_NAME, desc=mig._DESCRIPTION)

    await session.execute(stmt)
    await session.commit()

    row = (
        await session.execute(
            select(JobConfig).where(JobConfig.name == mig._TASK_NAME)
        )
    ).scalar_one()
    assert row.task_type == JobTaskType.TRADE_CALENDAR_REFRESH
    assert row.kind == JobKind.SYSTEM
    assert row.enabled is True
    assert row.cron_expr == "0 8 * * *"

    # 幂等：WHERE NOT EXISTS → 再执行一次仍只 1 行
    await session.execute(stmt)
    await session.commit()
    count = (
        await session.execute(
            select(func.count())
            .select_from(JobConfig)
            .where(JobConfig.name == mig._TASK_NAME)
        )
    ).scalar_one()
    assert count == 1


@pytest.mark.asyncio
async def test_handler_raises_when_fetch_failed_even_if_table_nonempty(
    session, monkeypatch
) -> None:
    """缺口 B：表里**已有旧数据**，但本次拉取失败（refresh 返回 0）→ 仍必须 FAILED，
    不得静默 SUCCESS（否则「日历陈旧」不可见）。"""
    session.add(MarketTradeCalendar(trade_date=date(2020, 1, 1)))
    await session.commit()

    async def _fetch_failed(
        sess, *, full: bool = False, start_date: date | None = None
    ) -> TradeCalendarRefresh:  # noqa: ARG001
        return TradeCalendarRefresh(0, 0)  # 拉取失败：源 0 个

    monkeypatch.setattr(dyf, "refresh_trade_calendar", _fetch_failed)

    with pytest.raises(RuntimeError, match="未拉取到任何交易日"):
        await run_trade_calendar_refresh(_stub_cfg())


def _fake_akshare(trade_dates: list[str]):
    """构造假 akshare 模块：``tool_trade_date_hist_sina`` 返回含 ``trade_date`` 列的 DataFrame。"""
    import pandas as pd

    class _FakeAkShare:
        @staticmethod
        def tool_trade_date_hist_sina():
            return pd.DataFrame({"trade_date": trade_dates})

    return _FakeAkShare


@pytest.mark.asyncio
async def test_refresh_incremental_inserts_only_missing(session, monkeypatch) -> None:
    """增量（默认）：只 INSERT 缺失日期，**已存在的行不被触碰**（updated_at 不刷新）。"""
    t = today_app_tz()
    d_exist = t - timedelta(days=10)
    d_new = t - timedelta(days=9)
    old_ts = datetime(2000, 1, 1, tzinfo=timezone.utc)
    session.add(MarketTradeCalendar(trade_date=d_exist, updated_at=old_ts))
    await session.commit()

    monkeypatch.setitem(
        sys.modules, "akshare", _fake_akshare([d_exist.isoformat(), d_new.isoformat()])
    )
    res = await refresh_trade_calendar(session)
    await session.commit()

    assert res.fetched == 2 and res.written == 1  # 只新增 d_new
    existing_ts = (
        await session.execute(
            select(MarketTradeCalendar.updated_at).where(
                MarketTradeCalendar.trade_date == d_exist
            )
        )
    ).scalar_one()
    assert existing_ts == old_ts  # 已有行未被 UPDATE
    # 幂等：再跑一次零新增
    res2 = await refresh_trade_calendar(session)
    await session.commit()
    assert res2.fetched == 2 and res2.written == 0


@pytest.mark.asyncio
async def test_refresh_full_upserts_existing(session, monkeypatch) -> None:
    """全量（full=True）：upsert 全窗口，已有行 updated_at 被刷新。"""
    t = today_app_tz()
    d_exist = t - timedelta(days=10)
    d_new = t - timedelta(days=9)
    old_ts = datetime(2000, 1, 1, tzinfo=timezone.utc)
    session.add(MarketTradeCalendar(trade_date=d_exist, updated_at=old_ts))
    await session.commit()

    monkeypatch.setitem(
        sys.modules, "akshare", _fake_akshare([d_exist.isoformat(), d_new.isoformat()])
    )
    res = await refresh_trade_calendar(session, full=True)
    await session.commit()

    assert res.fetched == 2 and res.written == 2
    existing_ts = (
        await session.execute(
            select(MarketTradeCalendar.updated_at).where(
                MarketTradeCalendar.trade_date == d_exist
            )
        )
    ).scalar_one()
    assert existing_ts != old_ts  # 全量刷新了已有行


@pytest.mark.asyncio
async def test_handler_reads_full_param(session, monkeypatch) -> None:
    """handler 由 ``cfg.params["full"]`` 决定写入模式并透传给 refresh。"""
    captured: dict[str, bool] = {}

    async def _fake(
        sess, *, full: bool = False, start_date: date | None = None
    ) -> TradeCalendarRefresh:  # noqa: ARG001
        captured["full"] = full
        sess.add(MarketTradeCalendar(trade_date=today_app_tz()))  # 保证 total > 0
        return TradeCalendarRefresh(1, 1)

    monkeypatch.setattr(dyf, "refresh_trade_calendar", _fake)
    cfg = types.SimpleNamespace(
        task_type=JobTaskType.TRADE_CALENDAR_REFRESH, params={"full": True}
    )
    await run_trade_calendar_refresh(cfg)

    assert captured["full"] is True


def test_handler_meta_exposes_full_toggle() -> None:
    """系统任务元数据暴露 full 布尔开关（前端据此渲染；creatable=False 不进新建清单）。"""
    from app.modules.admin.schedule import _HANDLER_META

    meta = _HANDLER_META[JobTaskType.TRADE_CALENDAR_REFRESH]
    assert meta["creatable"] is False
    fields = {f["key"]: f for f in meta["param_fields"]}
    assert fields["full"]["type"] == "boolean"


@pytest.mark.asyncio
async def test_refresh_respects_configured_start_date(session, monkeypatch) -> None:
    """配置起始日期决定窗口下限：早于该日的交易日不落库（默认下限为「去年 1 月 1 日」）。"""
    t = today_app_tz()
    d_before = t - timedelta(days=200)
    d_after = t - timedelta(days=50)
    monkeypatch.setitem(
        sys.modules,
        "akshare",
        _fake_akshare([d_before.isoformat(), d_after.isoformat()]),
    )
    # 未配置 → 默认下限（去年 1 月 1 日）→ 两个都在窗口内
    res = await refresh_trade_calendar(session)
    await session.commit()
    assert res.fetched == 2 and res.written == 2

    # 清空后按配置起始日再跑 → 只收 >= start_date 的
    await session.execute(sa.delete(MarketTradeCalendar))
    await session.commit()
    res2 = await refresh_trade_calendar(session, start_date=t - timedelta(days=100))
    await session.commit()
    assert res2.fetched == 1 and res2.written == 1
    got = (
        await session.execute(select(MarketTradeCalendar.trade_date))
    ).scalars().all()
    assert got == [d_after]


@pytest.mark.asyncio
async def test_handler_uses_configured_calendar_start_date(session, monkeypatch) -> None:
    """handler 从 dividend_yield_settings.trade_calendar_start_date 取窗口下限并透传。"""
    t = today_app_tz()
    start = t - timedelta(days=100)
    session.add(
        DividendYieldSettings(
            trade_calendar_start_date=start,
        )
    )
    await session.commit()

    captured: dict[str, object] = {}

    async def _fake(sess, *, full: bool = False, start_date: date | None = None):  # noqa: ARG001
        captured["start_date"] = start_date
        sess.add(MarketTradeCalendar(trade_date=t))
        return TradeCalendarRefresh(1, 1)

    monkeypatch.setattr(dyf, "refresh_trade_calendar", _fake)
    await run_trade_calendar_refresh(_stub_cfg())

    assert captured["start_date"] == start


@pytest.mark.asyncio
async def test_refresh_full_prunes_rows_before_start_date(session, monkeypatch) -> None:
    """全量（full=True）：除 upsert 窗口内交易日外，还**删除早于起始日期的历史行**——
    收紧起始日期后旧数据不应残留（否则「改成 2026 起始、2025 数据还在」不可预期）。"""
    t = today_app_tz()
    d_old = t - timedelta(days=200)  # 早于本次起始日 → 应被清理
    d_keep = t - timedelta(days=50)  # 窗口内 → 保留
    session.add(MarketTradeCalendar(trade_date=d_old))
    await session.commit()

    monkeypatch.setitem(
        sys.modules,
        "akshare",
        _fake_akshare([d_old.isoformat(), d_keep.isoformat()]),
    )
    start = t - timedelta(days=100)
    res = await refresh_trade_calendar(session, full=True, start_date=start)
    await session.commit()

    # 源给了 2 个日期，但 d_old 在窗口外 → 只 upsert 1 行、清理 1 行
    assert res.fetched == 1 and res.written == 1 and res.pruned == 1
    got = (
        await session.execute(select(MarketTradeCalendar.trade_date))
    ).scalars().all()
    assert got == [d_keep]


@pytest.mark.asyncio
async def test_refresh_incremental_keeps_rows_before_start_date(
    session, monkeypatch
) -> None:
    """增量（默认）**不删除**任何行：窗口外的历史数据原样保留，pruned 恒为 0。"""
    t = today_app_tz()
    d_old = t - timedelta(days=200)
    d_keep = t - timedelta(days=50)
    session.add(MarketTradeCalendar(trade_date=d_old))
    await session.commit()

    monkeypatch.setitem(
        sys.modules,
        "akshare",
        _fake_akshare([d_old.isoformat(), d_keep.isoformat()]),
    )
    res = await refresh_trade_calendar(session, start_date=t - timedelta(days=100))
    await session.commit()

    assert res.fetched == 1 and res.written == 1 and res.pruned == 0
    got = (
        await session.execute(select(MarketTradeCalendar.trade_date))
    ).scalars().all()
    assert sorted(got) == sorted([d_old, d_keep])
