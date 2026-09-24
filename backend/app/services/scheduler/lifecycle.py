"""调度生命周期：job 注册、调度器启停、手动/重载触发。

调度器唯一引用与 HTTP 超时常量集中在 ``_state``，本模块通过 ``_state._scheduler``
属性赋值实现原文件中的 ``global _scheduler`` 语义（拆包后 ``global`` 不再指向同一模块）。
"""
from __future__ import annotations

import asyncio
from typing import Any

from app.core.bg import track_task
from app.core.config import get_settings
from app.core.date_utils import APP_TZ
from app.db.database import AsyncSessionLocal
from sqlalchemy import select
from app.models import JobConfig, UserQuoteSyncConfig
from app.models.enums import JobTriggerSource

from . import _state
from .runner import _run_job
from .user_sync import _run_user_quote_sync


def _register_job(sched: Any, cfg: JobConfig) -> None:
    """把一个 task 配置注册为 cron job（id=配置 id，天然幂等可 replace）。"""
    from apscheduler.triggers.cron import CronTrigger

    sched.add_job(
        _run_job,
        CronTrigger.from_crontab(cfg.cron_expr, timezone=APP_TZ),
        args=[cfg.id, JobTriggerSource.SCHEDULED],
        id=str(cfg.id),
        # name 仅用于日志展示，不参与 id 冲突判定；APScheduler 默认会退化成 "_run_job"
        name=cfg.name or str(cfg.id),
        replace_existing=True,
    )


def _register_user_job(sched: Any, cfg: UserQuoteSyncConfig) -> None:
    """把一个用户行情同步配置注册为 cron job（id=user:{user_id}，幂等可 replace）。

    周期按 frequency 显式构造 CronTrigger：
    - DAY   ：CronTrigger(hour, minute)
    - WEEK  ：CronTrigger(day_of_week=weekday-1, hour, minute)（APScheduler 0=周一..6=周日）
    - MONTH ：CronTrigger(day=day_of_month, hour, minute)
    """
    from apscheduler.triggers.cron import CronTrigger

    hour, minute = (int(p) for p in cfg.time.split(":"))
    if cfg.frequency == "WEEK":
        trigger = CronTrigger(day_of_week=cfg.weekday - 1, hour=hour, minute=minute)
    elif cfg.frequency == "MONTH":
        trigger = CronTrigger(day=cfg.day_of_month, hour=hour, minute=minute)
    else:  # DAY（含未知值按 DAY 处理）
        trigger = CronTrigger(hour=hour, minute=minute)
    sched.add_job(
        _run_user_quote_sync,
        trigger,
        args=[cfg.user_id],
        id=f"user:{cfg.user_id}",
        # UserQuoteSyncConfig 没有可读 name 字段，用「类型 + user_id」拼一个可辨识串
        name=f"行情同步:{cfg.user_id}",
        replace_existing=True,
    )


async def start_scheduler() -> None:
    """应用启动时调用：受 SCHEDULER_ENABLED 总开关控制，加载库中 enabled 任务注册。"""
    settings = get_settings()
    if not settings.SCHEDULER_ENABLED:
        return
    if _state._scheduler is not None:
        return
    from apscheduler.schedulers.asyncio import AsyncIOScheduler

    sched = AsyncIOScheduler(timezone=APP_TZ)
    sched.start()
    _state._scheduler = sched
    await reload_schedule()


async def reload_schedule() -> None:
    """任务增删改 / 启停后调用：移除全部 job 并按库重载，使调度与 DB 保持一致。"""
    settings = get_settings()
    if not settings.SCHEDULER_ENABLED or _state._scheduler is None:
        return
    sched = _state._scheduler
    for job in list(sched.get_jobs()):  # type: ignore[union-attr]
        job.remove()
    async with AsyncSessionLocal() as session:
        rows = (
            await session.execute(
                select(JobConfig).where(JobConfig.enabled == True)  # noqa: E712
            )
        ).scalars().all()
    for cfg in rows:
        try:
            _register_job(sched, cfg)
        except Exception:
            # 单个任务 cron 非法仅跳过，不影响其余任务；问题经手动触发 / 日志暴露
            continue
    # 用户级行情同步配置：每个 enabled 用户注册 cron job（id=user:{user_id}）
    async with AsyncSessionLocal() as session:
        user_cfgs = (
            await session.execute(
                select(UserQuoteSyncConfig).where(
                    UserQuoteSyncConfig.enabled == True  # noqa: E712
                )
            )
        ).scalars().all()
    for ucfg in user_cfgs:
        try:
            _register_user_job(sched, ucfg)
        except Exception:
            # 单个用户配置非法仅跳过，不影响其余用户；问题经手动触发 / 配置校验暴露
            continue


def run_task_now(job_id: str) -> None:
    """管理员手动立即执行：直接调度 _run_job，不依赖全局调度器（总开关关闭也可用）。"""
    track_task(
        asyncio.get_running_loop().create_task(_run_job(job_id, JobTriggerSource.MANUAL))
    )


def shutdown_scheduler() -> None:
    """应用关闭时调用：停止并释放调度器。"""
    if _state._scheduler is not None:
        _state._scheduler.shutdown(wait=False)  # type: ignore[attr-defined]
        _state._scheduler = None
