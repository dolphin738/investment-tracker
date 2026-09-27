"""单次任务执行内核：per-job 运行锁 + 执行日志落库（RUNNING → SUCCESS/FAILED）。

``_run_job`` 外层持有 per-job 运行锁（cron 与手动 trigger 并发去重），``_run_job_inner``
是真正执行与落日志的内核，二者均引用 ``_state`` 中的共享可变集合与处理器注册表。
"""
from __future__ import annotations

import asyncio
import inspect
import logging
from datetime import datetime, timezone

from sqlalchemy import delete as sa_delete, select

from app.db.database import AsyncSessionLocal
from app.models import JobConfig, JobRunLog
from app.models.enums import JobRunStatus, JobTriggerSource

from ._state import _running_job_ids
from .handlers import _HANDLERS

logger = logging.getLogger(__name__)

# 协程被取消（应用关闭 / APScheduler shutdown / 手动取消）时的终态文案。
# 该分支必须落终态：CancelledError 是 BaseException，不会命中下面 except Exception，
# 否则日志会永久停在 RUNNING（与「进程被强杀」同款现象）。
_CANCELLED_ERROR = "执行被取消（应用关闭 / 协程取消），未跑到结束，由调度器记为失败"


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
        cancelled_exc: BaseException | None = None
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
            # 成功必须清 error：回收器可能已给这行打过「执行中断」标记（误判自愈场景
            # ——见 reaper 模块 docstring），若成功时不清，日志会以 SUCCESS 状态长期
            # 挂着一条中断文案，在管理端执行日志里误导运维。
            log.error = None
        except asyncio.CancelledError as exc:
            # CancelledError 是 BaseException：不补这一支，被取消的执行日志会永久
            # 停在 RUNNING。此处只补记终态，取消语义原样向上传播（不吞）。
            cancelled_exc = exc
            log.status = JobRunStatus.FAILED
            log.error = _CANCELLED_ERROR
        except Exception as exc:  # 任务异常落库为 FAILED，不中断调度器
            log.status = JobRunStatus.FAILED
            log.error = str(exc)
        log.finished_at = datetime.now(timezone.utc)
        if cancelled_exc is not None:
            # 取消期尽最大努力落终态；落库失败也不得掩盖 CancelledError 语义。
            try:
                await session.commit()
            except Exception:
                logger.warning("任务取消后执行日志落终态失败", exc_info=True)
            raise cancelled_exc
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
