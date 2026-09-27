"""定时任务执行日志「永久 RUNNING」缺陷回归（孤儿回收 + 取消落终态）。

缺陷：管理端「定时任务 → 执行日志」里长期存在一条状态为「执行中」的记录，
即使任务已 ``enabled=false`` 也不再流转。根因链条（见 reaper.py docstring）：

1. ``runner._run_job_inner`` 先写 RUNNING 并 commit，跑完再回填终态并二次 commit；
   两次 commit 之间没有 DB 侧可观测的「运行中」标记，进程被强杀/重部署时该行
   **永久停在 RUNNING**（真根因，本次以启动期回收修复）。
2. ``asyncio.CancelledError`` 是 BaseException，不命中 ``except Exception`` →
   协程被取消（应用关闭）时同样留下 RUNNING 行（第二个真根因，补落终态分支修复）。
3. 用户「取消」链路**不适用于**定时任务：``JobRunStatus`` 无 CANCELLED 枚举值、
   admin 定时任务路由无取消端点；``admin_locks.cancel_requested_at`` 只服务
   **分红播种**（``LOCK_DIVIDEND_SEED``），与 ``job_configs`` 无关。故本文件不覆盖该链路。

守护断言（白盒，直连测试库）：
- 超宽限期的 RUNNING 行 → 被回收为 FAILED + 有 finished_at + 写明原因；
- 本进程正在跑（``_running_job_ids`` 中）的 job → **绝不被误杀**（长耗时 scan 场景）；
- 未超宽限期的 RUNNING 行 → 不动（启动竞态保险）；
- 已终态行（SUCCESS/FAILED）→ 不动；
- 协程被取消 → 日志落 FAILED 且 CancelledError 继续向上传播（取消语义不被吞）。
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

import app.db.database as dbmod
from app.models import JobRunLog
from app.models.enums import JobKind, JobRunStatus, JobTaskType, JobTriggerSource
from app.models.job import JobConfig
from app.services.scheduler import _running_job_ids
from app.services.scheduler import handlers as handlers_mod
from app.services.scheduler import runner as runner_mod
from app.services.scheduler.lifecycle import start_scheduler
from app.services.scheduler.reaper import reap_orphan_run_logs

pytestmark = pytest.mark.asyncio


async def _new_task(name: str) -> JobConfig:
    """建一个禁用的普通任务（不参与调度，仅供日志外键）。"""
    async with dbmod.AsyncSessionLocal() as s:
        cfg = JobConfig(
            name=name,
            kind=JobKind.NORMAL,
            task_type=JobTaskType.HTTP_CALLBACK,
            cron_expr="0 3 * * *",
            enabled=False,
            params={"url": "https://example.com/hook"},
        )
        s.add(cfg)
        await s.commit()
        return cfg


async def _new_log(
    cfg: JobConfig, status: JobRunStatus, started_at: datetime
) -> JobRunLog:
    """插入一条执行日志（started_at 显式给定，用于制造「陈旧 RUNNING」）。"""
    async with dbmod.AsyncSessionLocal() as s:
        log = JobRunLog(
            job_id=cfg.id,
            status=status,
            trigger_source=JobTriggerSource.SCHEDULED,
            started_at=started_at,
        )
        s.add(log)
        await s.commit()
        return log


async def _get_log(log_id: str) -> JobRunLog:
    async with dbmod.AsyncSessionLocal() as s:
        return (
            await s.execute(select(JobRunLog).where(JobRunLog.id == log_id))
        ).scalar_one()


async def test_stale_running_log_is_reaped_to_failed():
    """核心断言：陈旧的 RUNNING 行被回收为 FAILED，且写清 finished_at / error。"""
    cfg = await _new_task("孤儿回收-陈旧RUNNING")
    log = await _new_log(cfg, JobRunStatus.RUNNING, datetime.now(timezone.utc) - timedelta(hours=2))

    reaped = await reap_orphan_run_logs(grace_seconds=60)

    assert reaped == 1
    after = await _get_log(log.id)
    assert after.status == JobRunStatus.FAILED
    assert after.finished_at is not None
    assert "中断" in (after.error or "")


async def test_running_job_in_this_process_is_never_reaped():
    """本进程正在跑的 job 绝不回收——长耗时 scan（数小时）不得被误杀。"""
    cfg = await _new_task("孤儿回收-本进程运行中")
    log = await _new_log(cfg, JobRunStatus.RUNNING, datetime.now(timezone.utc) - timedelta(hours=10))
    _running_job_ids.add(cfg.id)
    try:
        reaped = await reap_orphan_run_logs(grace_seconds=60)
    finally:
        _running_job_ids.discard(cfg.id)

    assert reaped == 0
    after = await _get_log(log.id)
    assert after.status == JobRunStatus.RUNNING
    assert after.finished_at is None


async def test_fresh_running_log_within_grace_is_untouched():
    """宽限期内（启动竞态保险）的 RUNNING 行不动。"""
    cfg = await _new_task("孤儿回收-宽限期内")
    log = await _new_log(cfg, JobRunStatus.RUNNING, datetime.now(timezone.utc) - timedelta(seconds=5))

    reaped = await reap_orphan_run_logs(grace_seconds=300)

    assert reaped == 0
    after = await _get_log(log.id)
    assert after.status == JobRunStatus.RUNNING


async def test_terminal_logs_are_untouched():
    """已终态（SUCCESS / FAILED）的日志不受回收影响。"""
    cfg = await _new_task("孤儿回收-已终态")
    old = datetime.now(timezone.utc) - timedelta(days=3)
    ok = await _new_log(cfg, JobRunStatus.SUCCESS, old)
    bad = await _new_log(cfg, JobRunStatus.FAILED, old)

    reaped = await reap_orphan_run_logs(grace_seconds=60)

    assert reaped == 0
    assert (await _get_log(ok.id)).status == JobRunStatus.SUCCESS
    assert (await _get_log(bad.id)).status == JobRunStatus.FAILED


async def test_start_scheduler_reaps_orphans():
    """启动链路守卫：``start_scheduler`` 必须先回收孤儿 RUNNING 再注册 cron。"""
    from app.services.scheduler import shutdown_scheduler

    cfg = await _new_task("孤儿回收-启动链路")
    log = await _new_log(cfg, JobRunStatus.RUNNING, datetime.now(timezone.utc) - timedelta(hours=1))
    try:
        await start_scheduler()
    finally:
        shutdown_scheduler()

    after = await _get_log(log.id)
    assert after.status == JobRunStatus.FAILED
    assert after.finished_at is not None


async def test_cancelled_handler_still_writes_terminal_status():
    """协程被取消：日志落 FAILED（不再永久 RUNNING），且 CancelledError 继续上抛。"""
    cfg = await _new_task("取消-落终态")

    async def _cancelled_handler(job_cfg: JobConfig) -> str:
        raise asyncio.CancelledError()

    original = handlers_mod._HANDLERS[JobTaskType.HTTP_CALLBACK]
    handlers_mod._HANDLERS[JobTaskType.HTTP_CALLBACK] = _cancelled_handler
    try:
        with pytest.raises(asyncio.CancelledError):
            await runner_mod._run_job_inner(cfg.id, JobTriggerSource.MANUAL)
    finally:
        handlers_mod._HANDLERS[JobTaskType.HTTP_CALLBACK] = original

    async with dbmod.AsyncSessionLocal() as s:
        log = (
            await s.execute(
                select(JobRunLog)
                .where(JobRunLog.job_id == cfg.id)
                .order_by(JobRunLog.started_at.desc())
            )
        ).scalars().first()
    assert log is not None
    assert log.status == JobRunStatus.FAILED
    assert log.finished_at is not None
    assert "取消" in (log.error or "")
