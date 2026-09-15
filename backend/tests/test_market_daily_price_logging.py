"""回补常量 + 批次异常可观测性 + 失败聚合落 app_logs + 任务状态（mock 网络层）。

自 ``test_market_daily_price_sync.py`` 拆出（T04 测试拆分，每个文件 ≤400 行）。
守护：附录 A.11 / 决策 A15 回补常量；D1/D2 批次异常类名与重试退避；T1-b 失败批次聚合落
``app_logs``（每轮最多 1 条）；T2 零写入 → 任务状态落 FAILED（端到端）。
"""
from __future__ import annotations

import logging
from decimal import Decimal

import httpx
import pytest
from sqlalchemy import select

from app.core.date_utils import today_app_tz
from app.models import (
    AppLog,
    JobConfig,
    JobRunLog,
    MarketTradeCalendar,
    SecurityDividend,
)
from app.models.enums import (
    DividendStatus,
    JobKind,
    JobRunStatus,
    JobTaskType,
    JobTriggerSource,
    ReportPeriodType,
)
from app.services.market_data_sync import MarketDataSyncService
from app.services.market_daily_price_sync import MarketDailyPriceSyncService
from app.services.market_price_backfill_engine import (
    _BACKFILL_BACKOFFS,
    _BACKFILL_BURST,
    _BACKFILL_COOLDOWN_MAX,
    _BACKFILL_COOLDOWN_MIN,
)
from app.services.scheduler import _run_job_inner
from tests.helpers_price_backfill import add_master, seed_https_quote_source, uid


# ───────────────────────── 回补常量（决策 A15 / 附录 A.11） ─────────────────────────

def test_backfill_rate_constants():
    """守护附录 A.11 / 决策 A15：burst≈10、冷却 60-120s、退避 60/120/300s。"""
    assert _BACKFILL_BURST == 10
    assert _BACKFILL_COOLDOWN_MIN <= _BACKFILL_COOLDOWN_MAX
    assert _BACKFILL_COOLDOWN_MIN == 60.0
    assert _BACKFILL_COOLDOWN_MAX == 120.0
    assert _BACKFILL_BACKOFFS == (60, 120, 300)  # 指数退避，用尽即放弃该证券


# ───────────────────── 批次异常可观测性 + 重试退避（D1 / D2） ─────────────────────

@pytest.mark.asyncio
async def test_fetch_batch_warning_keeps_exception_type(session, caplog, monkeypatch):
    """守护 D1：异常消息为空（httpx 超时类 ``str(exc)==""``）时，warning 仍带**异常类名**。

    现场日志「收盘价批次 800 只请求异常 ，重试」的 ``%s`` 为空，正是 httpx 超时类异常
    （ConnectTimeout / ReadTimeout）消息为空的后果——类型信息彻底丢失、无法诊断。
    """
    import app.services.market_daily_price_sync as mds

    monkeypatch.setattr(mds, "_BATCH_RETRY_BACKOFF_SECONDS", 0)
    svc = MarketDailyPriceSyncService(session)

    async def _boom(itf_obj, params, codes):
        raise httpx.ConnectTimeout("")  # str(exc) == "" → 现场空壳日志的成因

    svc._mds._call_interface_raw = _boom
    with caplog.at_level(logging.WARNING):
        rows = await svc._fetch_batch_guarded(None, {}, ["600000", "600001"])

    assert rows is None
    messages = [r.getMessage() for r in caplog.records]
    # 关键：类名在日志里（不再空壳），空消息也不丢类型
    assert any("ConnectTimeout" in m for m in messages), messages
    assert any("请求异常" in m for m in messages), messages


@pytest.mark.asyncio
async def test_fetch_batch_retries_once_with_backoff(session, monkeypatch):
    """守护 D2：外层重试**恰好一次**（共 2 次请求），且重试前先退避（不再立即重打源站）。"""
    import types as _types

    import app.services.market_daily_price_sync as mds

    sleeps: list[float] = []

    async def _fake_sleep(delay):
        sleeps.append(delay)

    monkeypatch.setattr(mds, "asyncio", _types.SimpleNamespace(sleep=_fake_sleep))
    monkeypatch.setattr(mds, "_BATCH_RETRY_BACKOFF_SECONDS", 1.5)

    svc = MarketDailyPriceSyncService(session)
    calls = {"n": 0}

    async def _boom(itf_obj, params, codes):
        calls["n"] += 1
        raise RuntimeError("boom")

    svc._mds._call_interface_raw = _boom
    rows = await svc._fetch_batch_guarded(None, {}, ["600000"])

    assert rows is None
    assert calls["n"] == 2  # 恰好重试一次
    assert sleeps == [1.5]  # 重试前退避了 _BATCH_RETRY_BACKOFF_SECONDS


# ───────────── T1-b：失败批次聚合落 app_logs（结构化，可查） ─────────────

@pytest.mark.asyncio
async def test_daily_close_fetch_all_failed_logs_error(session, monkeypatch):
    """T1-b：整批失败（零写入）→ app_logs 新增**恰好 1 条** error（scope=system，含 error_kinds）。

    本轮故障（2026-09-15）这些批次级 warning 从不落 app_logs，只能靠任务级 message 追查；
    本用例守护「聚合落库、每轮最多 1 条」不再回归。
    """
    import app.services.market_daily_price_sync as mds

    monkeypatch.setattr(mds, "_BATCH_RETRY_BACKOFF_SECONDS", 0)

    today = today_app_tz()
    session.add(MarketTradeCalendar(trade_date=today))
    m = await add_master(session)
    session.add(
        SecurityDividend(master_id=m.id, report_year=today.year, report_quarter=1,
                         period_type=ReportPeriodType.ANNUAL,
                         cash_per_share=Decimal("1.0"), status=DividendStatus.PAID)
    )
    await seed_https_quote_source(session)
    await session.commit()

    svc = MarketDailyPriceSyncService(session)

    async def _boom(itf_obj, params, codes):
        raise httpx.ConnectError("connection refused")

    svc._mds._call_interface_raw = _boom
    with pytest.raises(RuntimeError):
        await svc.daily_close_fetch({})

    logs = (await session.execute(select(AppLog))).scalars().all()
    assert len(logs) == 1  # 每轮最多 1 条（绝不逐批刷）
    log = logs[0]
    assert log.level == "error"
    assert log.scope == "system"
    assert log.module == "market_daily_price_sync"
    assert log.detail["failed_batches"] == 1
    assert log.detail["total_rows"] == 0
    assert log.detail["codes_total"] == 1
    assert "ConnectError" in log.detail["error_kinds"]


@pytest.mark.asyncio
async def test_daily_close_fetch_partial_failure_logs_warning(session, monkeypatch):
    """T1-b：部分批次成功（total_rows>0 且 failed_batches>0）→ app_logs 1 条 warning，且不抛错。"""
    import app.services.market_daily_price_sync as mds

    monkeypatch.setattr(mds, "_BATCH_RETRY_BACKOFF_SECONDS", 0)

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
    # 每批 1 只 → 两只证券分两批：一批失败、一批成功
    await seed_https_quote_source(session, max_codes_per_request=1)
    await session.commit()

    svc = MarketDailyPriceSyncService(session)

    async def _flaky(itf_obj, params, codes):
        if "600001" in codes[0]:
            raise httpx.ConnectError("boom")  # 该批失败
        return [{"代码": "600002", "收盘": "10.5", "日期": today.isoformat()}]

    svc._mds._call_interface_raw = _flaky
    result = await svc.daily_close_fetch({})

    assert "失败批次 1" in result  # 部分失败仍返回 SUCCESS 计数串（不抛错）
    assert "成功行 1" in result
    logs = (await session.execute(select(AppLog))).scalars().all()
    assert len(logs) == 1
    assert logs[0].level == "warning"  # 有写入 → warning（非 error）
    assert logs[0].detail["failed_batches"] == 1
    assert logs[0].detail["total_rows"] == 1


@pytest.mark.asyncio
async def test_daily_close_fetch_success_writes_no_app_log(session):
    """T1-b 反向守卫：正常成功（failed_batches==0 且 total_rows>0）→ **不新增**任何 app_logs 行。

    防「每轮都刷日志」：只有失败/零写入才落库。
    """
    today = today_app_tz()
    session.add(MarketTradeCalendar(trade_date=today))
    m = await add_master(session)
    session.add(
        SecurityDividend(master_id=m.id, report_year=today.year, report_quarter=1,
                         period_type=ReportPeriodType.ANNUAL,
                         cash_per_share=Decimal("1.0"), status=DividendStatus.PAID)
    )
    await seed_https_quote_source(session)
    await session.commit()

    svc = MarketDailyPriceSyncService(session)

    async def _ok(itf_obj, params, codes):
        return [{"代码": "600000", "收盘": "12.34", "日期": today.isoformat()}]

    svc._mds._call_interface_raw = _ok
    result = await svc.daily_close_fetch({})

    assert "成功行 1" in result
    logs = (await session.execute(select(AppLog))).scalars().all()
    assert logs == []  # 正常成功不落任何 app_logs


# ───────────── T2：零写入 → 任务状态落 FAILED（端到端） ─────────────

async def _seed_daily_close_job(session, today):
    """造「今日交易日 + 1 只有分红证券 + HTTPS 行情源 + 日抓任务」的最小可运行集，返回 job id。"""
    session.add(MarketTradeCalendar(trade_date=today))
    m = await add_master(session)
    session.add(
        SecurityDividend(master_id=m.id, report_year=today.year, report_quarter=1,
                         period_type=ReportPeriodType.ANNUAL,
                         cash_per_share=Decimal("1.0"), status=DividendStatus.PAID)
    )
    await seed_https_quote_source(session)
    cfg = JobConfig(
        name=f"daily-close-e2e-{uid()}",
        kind=JobKind.NORMAL,
        task_type=JobTaskType.MARKET_DAILY_CLOSE_FETCH,
        cron_expr="5 15 * * *",
        enabled=True,
        params={},
    )
    session.add(cfg)
    await session.commit()
    return cfg.id


@pytest.mark.asyncio
async def test_run_job_inner_zero_writes_marks_failed(session, monkeypatch):
    """T2 端到端：源全失败 → 零写入 → 任务状态从「假成功」改为 **FAILED**。

    只跑 service 抛错不算证明任务状态变了——必须实跑 ``_run_job_inner`` 落 ``JobRunLog``，
    断言 ``status == FAILED`` 且 ``error`` 含「失败批次」。
    """
    import app.services.market_daily_price_sync as mds

    monkeypatch.setattr(mds, "_BATCH_RETRY_BACKOFF_SECONDS", 0)
    today = today_app_tz()
    job_id = await _seed_daily_close_job(session, today)

    async def _boom(self, itf_obj, params, codes):
        raise httpx.ConnectError("connection refused")

    # 类级 patch：handler 在 run_market_daily_close_fetch 内自建 MarketDataSyncService
    monkeypatch.setattr(MarketDataSyncService, "_call_interface_raw", _boom)

    await _run_job_inner(job_id, JobTriggerSource.SCHEDULED)

    log = (
        await session.execute(select(JobRunLog).where(JobRunLog.job_id == job_id))
    ).scalars().one()
    assert log.status == JobRunStatus.FAILED
    assert "失败批次" in (log.error or "")


@pytest.mark.asyncio
async def test_run_job_inner_success_marks_success(session, monkeypatch):
    """T2 反向守卫：源正常 → 有写入 → 任务状态仍为 **SUCCESS**（防「恒 FAILED」也能过测）。

    依赖 ``test_run_job_inner_zero_writes_marks_failed`` 之外的这条反向断言，确保改动不是
    简单地把状态写死成 FAILED。
    """
    today = today_app_tz()
    job_id = await _seed_daily_close_job(session, today)

    async def _ok(self, itf_obj, params, codes):
        return [{"代码": "600000", "收盘": "12.0", "日期": today.isoformat()}]

    monkeypatch.setattr(MarketDataSyncService, "_call_interface_raw", _ok)

    await _run_job_inner(job_id, JobTriggerSource.SCHEDULED)

    log = (
        await session.execute(select(JobRunLog).where(JobRunLog.job_id == job_id))
    ).scalars().one()
    assert log.status == JobRunStatus.SUCCESS
    assert "成功行 1" in (log.message or "")
