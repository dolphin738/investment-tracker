"""交易日历刷新独立系统任务单测（§5.5 防线一 / §7 stale 基准）。

守护本次拆分：把原先「只在五年留存清理里顺带刷新」的交易日历刷新，拆成独立系统定时任务
``TRADE_CALENDAR_REFRESH``，使 ``market_trade_calendar`` 表稳定被填充。覆盖：

- handler 在调度器注册表 ``_HANDLERS`` 中存在且指向 ``run_trade_calendar_refresh``；
- 迁移已把 ``TRADE_CALENDAR_REFRESH`` 写入原生枚举（用 INSERT 隐含校验）；
- handler 正常路径返回含「交易日历刷新完成」的摘要（monkeypatch 注入一行日历）；
- handler 在日历**仍为空**时抛 ``RuntimeError``（把 refresh 内部吞掉的失败显性化 → FAILED）。
"""
from __future__ import annotations

import types
from datetime import date

import pytest
from sqlalchemy import select

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

    async def _fake_refresh(sess) -> None:
        sess.add(MarketTradeCalendar(trade_date=date(2025, 3, 3)))
        sess.add(MarketTradeCalendar(trade_date=date(2025, 3, 4)))

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
    """守护失败显性化：refresh 为 no-op（内部吞异常）且表为空 → 抛 RuntimeError。"""

    async def _noop_refresh(sess) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(dyf, "refresh_trade_calendar", _noop_refresh)

    with pytest.raises(RuntimeError, match="交易日历刷新后仍为空"):
        await run_trade_calendar_refresh(_stub_cfg())
