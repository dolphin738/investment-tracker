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
import types
from datetime import date
from pathlib import Path

import pytest
import sqlalchemy as sa
from sqlalchemy import func, select

import app.services.dividend_yield_refresh as dyf
from app.models import JobConfig, MarketTradeCalendar
from app.models.enums import JobKind, JobTaskType
from app.services.dividend_yield_refresh import run_trade_calendar_refresh
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

    async def _fake_refresh(sess) -> int:
        sess.add(MarketTradeCalendar(trade_date=date(2025, 3, 3)))
        sess.add(MarketTradeCalendar(trade_date=date(2025, 3, 4)))
        return 2  # 本次拉取 2 个交易日

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

    async def _fetch_ok_but_no_write(sess) -> int:  # noqa: ARG001
        return 5  # 声称拉到 5 个交易日，但一行未落（异常态）

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

    async def _fetch_failed(sess) -> int:  # noqa: ARG001
        return 0  # refresh_trade_calendar 吞异常/空数据后返回 0

    monkeypatch.setattr(dyf, "refresh_trade_calendar", _fetch_failed)

    with pytest.raises(RuntimeError, match="未拉取到任何交易日"):
        await run_trade_calendar_refresh(_stub_cfg())
