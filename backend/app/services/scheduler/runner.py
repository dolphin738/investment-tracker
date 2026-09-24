"""单次任务执行内核：per-job 运行锁 + 执行日志落库（RUNNING → SUCCESS/FAILED）。

``_run_job`` 外层持有 per-job 运行锁（cron 与手动 trigger 并发去重），``_run_job_inner``
是真正执行与落日志的内核，二者均引用 ``_state`` 中的共享可变集合与处理器注册表。
"""
from __future__ import annotations

import inspect
from datetime import datetime, timezone

from sqlalchemy import delete as sa_delete, select

from app.db.database import AsyncSessionLocal
from app.models import JobConfig, JobRunLog
from app.models.enums import JobRunStatus, JobTriggerSource

from ._state import _running_job_ids
from .handlers import _HANDLERS


async def _run_job(job_id: str, source: JobTriggerSource) -> None:
    """执行单个任务并写执行日志。外层持有 per-job 运行锁，防 cron/手动并发堆叠。"""
    if job_id in _running_job_ids:
        return
    _running_job_ids.add(job_id)
    try:
        await _run_job_inner(job_id, source)
    finally:
        _running_job_ids.discard(job_id)


async def _run_job_inner(job_id: str, source: JobTriggerSource) -> None:
    """执行单个任务并写执行日志（RUNNING → SUCCESS/FAILED）。定时与手动共用。"""
    start = datetime.now(timezone.utc)
    async with AsyncSessionLocal() as session:
        cfg = await session.get(JobConfig, job_id)
        if cfg is None:
            return
        log = JobRunLog(
            job_id=job_id,
            status=JobRunStatus.RUNNING,
            trigger_source=source,
            started_at=start,
        )
        session.add(log)
        await session.commit()
        try:
            handler = _HANDLERS.get(cfg.task_type)
            if handler is None:
                raise RuntimeError(f"未注册的任务类型：{cfg.task_type}")
            # 感知触发源的 handler（第二参数 source，如季末 guard 对手动触发放行 P1-2）
            # 按签名分派；其余 handler 仍单参调用，注册表契约不变
            if len(inspect.signature(handler).parameters) >= 2:
                message = await handler(cfg, source)
            else:
                message = await handler(cfg)
            log.status = JobRunStatus.SUCCESS
            log.message = message
        except Exception as exc:  # 任务异常落库为 FAILED，不中断调度器
            log.status = JobRunStatus.FAILED
            log.error = str(exc)
        log.finished_at = datetime.now(timezone.utc)
        await session.commit()
        # 保留策略：任务配置了 max_logs 时，删除该任务开始时间最旧、超出上限的日志
        if cfg.max_logs and cfg.max_logs > 0:
            await _prune_run_logs(session, job_id, cfg.max_logs)


async def _prune_run_logs(session, job_id: str, max_logs: int) -> None:
    """按保留条数上限裁剪执行日志：保留最新 max_logs 条，删除更旧记录。

    started_at 同秒时用 id 作为次级排序保证确定性（始终保住最新写入的日志）。
    """
    stale_ids = (
        await session.execute(
            select(JobRunLog.id)
            .where(JobRunLog.job_id == job_id)
            .order_by(JobRunLog.started_at.desc(), JobRunLog.id.desc())
            .offset(max_logs)
        )
    ).scalars().all()
    if not stale_ids:
        return
    await session.execute(
        sa_delete(JobRunLog).where(JobRunLog.id.in_(stale_ids))
    )
    await session.commit()
