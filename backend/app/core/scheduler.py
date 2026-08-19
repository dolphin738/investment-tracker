"""统一定时调度器 — 数据库驱动的 APScheduler AsyncIOScheduler。

把两种既有定任务实现收敛为同一套数据库驱动调度：
- 行情同步已改造为「每用户独立配置」（见 user_quote_sync_configs，按日/周/月周期
  只同步本人组合），不再作为全局普通任务 MARKET_DATA_SYNC。
- 账户清理（原 external cron 调 /api/internal/cleanup）→ 系统任务 ``ACCOUNT_CLEANUP``。

职责：
- ``start_scheduler``：应用启动时创建 ``AsyncIOScheduler``，从 ``job_configs`` 加载全部
  ``enabled`` 任务并注册为 cron job；受 ``SCHEDULER_ENABLED`` 总开关控制。
- ``reload_schedule``：任务增删改 / 启停后移除全部 job 并按库重载（保持调度与库一致）。
- ``run_task_now``：管理员手动立即执行（不依赖全局调度器，即使调度总开关关闭也可用）。
- 每次执行（定时或手动）写入 ``job_run_logs``：RUNNING → SUCCESS/FAILED + 起止时间 + 信息。

设计取舍：
- 每个 handler 用独立的 ``AsyncSessionLocal`` 会话做业务，执行日志用单独会话写，互不干扰。
- 单个任务 cron 表达式非法仅跳过注册，不影响其余任务（异常由手动触发 / 列表日志暴露）。
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, Callable, Optional

import httpx
from sqlalchemy import select

from app.core.config import get_settings
from app.db.database import AsyncSessionLocal
from app.models import JobConfig, JobRunLog, Portfolio, UserQuoteSyncConfig
from app.models.enums import JobRunStatus, JobTaskType, JobTriggerSource
from app.services.cleanup import CleanupService
from app.services.market_data_sync import MarketDataSyncService

# 模块级唯一调度器引用，便于 shutdown 安全停止
_scheduler: Optional[object] = None

# 本地命令默认超时（秒）
_LOCAL_COMMAND_TIMEOUT = 600
# HTTP 回调默认超时（秒）
_HTTP_TIMEOUT = 30


# --------------------------------------------------------------------------- #
# 处理器注册表：任务类型 → 异步处理器（入参 JobConfig，返回执行摘要字符串）
# --------------------------------------------------------------------------- #
async def _security_master_sync(cfg: JobConfig) -> str:
    """配置驱动同步系统级证券主数据（遍历全部 MASTER_LIST 接口的资产类别）。"""
    async with AsyncSessionLocal() as session:
        result = await MarketDataSyncService(session).sync_all_security_masters()
        await session.commit()
    return (
        f"证券主数据同步完成：成功 {result.get('synced', 0)}，"
        f"失败 {result.get('failed', 0)}"
    )


async def _accounts_cleanup(cfg: JobConfig) -> str:
    """物理清理已过保留期的软删除账户（对齐原 /api/internal/cleanup/accounts 语义）。"""
    async with AsyncSessionLocal() as session:
        deleted = await CleanupService(session).physical_purge()
    return f"已物理清理 {deleted} 个过期账户"


async def _local_command(cfg: JobConfig) -> str:
    """定时执行本地脚本/命令（params.command，超时截断）。"""
    params = cfg.params or {}
    command = (params.get("command") or "").strip()
    if not command:
        raise RuntimeError("LOCAL_COMMAND 任务缺少参数 command")
    proc = await asyncio.create_subprocess_shell(
        command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    out, _ = await asyncio.wait_for(proc.communicate(), timeout=_LOCAL_COMMAND_TIMEOUT)
    output = out.decode("utf-8", errors="replace").strip()
    return f"exit={proc.returncode} {output}" if output else f"exit={proc.returncode}"


async def _http_callback(cfg: JobConfig) -> str:
    """执行 HTTP 回调（params.url / method / body）。"""
    params = cfg.params or {}
    url = (params.get("url") or "").strip()
    if not url:
        raise RuntimeError("HTTP_CALLBACK 任务缺少参数 url")
    method = (params.get("method") or "POST").upper()
    body = params.get("body")
    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
        resp = await client.request(method, url, json=body if isinstance(body, dict) else None)
    if resp.status_code >= 400:
        raise RuntimeError(f"HTTP 回调失败：{resp.status_code}")
    return f"HTTP {resp.status_code}"


_HANDLERS: dict[JobTaskType, Callable[[JobConfig], Any]] = {
    JobTaskType.SECURITY_MASTER_SYNC: _security_master_sync,
    JobTaskType.ACCOUNT_CLEANUP: _accounts_cleanup,
    JobTaskType.LOCAL_COMMAND: _local_command,
    JobTaskType.HTTP_CALLBACK: _http_callback,
}


# --------------------------------------------------------------------------- #
# 单次执行：日志埋点 + 运行 + 落结果
# --------------------------------------------------------------------------- #
async def _run_job(job_id: str, source: JobTriggerSource) -> None:
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
            message = await handler(cfg)
            log.status = JobRunStatus.SUCCESS
            log.message = message
        except Exception as exc:  # 任务异常落库为 FAILED，不中断调度器
            log.status = JobRunStatus.FAILED
            log.error = str(exc)
        log.finished_at = datetime.now(timezone.utc)
        await session.commit()


# --------------------------------------------------------------------------- #
# 用户级行情自动同步（每用户独立配置，只同步本人组合；不写 job_run_logs）
# --------------------------------------------------------------------------- #
async def _run_user_quote_sync(user_id: str) -> None:
    """按用户配置同步其本人所属全部组合行情，并回写执行状态到 user_quote_sync_configs。

    逐组合用独立会话同步 + 提交；全程任一步异常 → last_status=FAILED 并写错误文本，
    否则 SUCCESS + "已同步 N 个组合"。执行结果不回写 job_run_logs。
    """
    async with AsyncSessionLocal() as session:
        portfolio_ids = (
            await session.execute(
                select(Portfolio.id).where(Portfolio.user_id == user_id)
            )
        ).scalars().all()
    count = 0
    error_text: Optional[str] = None
    try:
        for pid in portfolio_ids:
            async with AsyncSessionLocal() as s:
                await MarketDataSyncService(s).sync_portfolio_prices(pid)
                await s.commit()
            count += 1
    except Exception as exc:  # 同步失败记为 FAILED 并回写错误文本，不中断其余逻辑
        error_text = str(exc)
    async with AsyncSessionLocal() as session:
        cfg = await session.get(UserQuoteSyncConfig, user_id)
        if cfg is not None:
            cfg.last_run_at = datetime.now(timezone.utc)
            if error_text is None:
                cfg.last_status = "SUCCESS"
                cfg.last_message = f"已同步 {count} 个组合"
            else:
                cfg.last_status = "FAILED"
                cfg.last_message = error_text[:512]
            await session.commit()


def run_user_sync_now(user_id: str) -> None:
    """用户手动立即触发自己的行情同步：直接调度 _run_user_quote_sync，不依赖全局调度器。"""
    asyncio.get_running_loop().create_task(_run_user_quote_sync(user_id))


# --------------------------------------------------------------------------- #
# 调度生命周期
# --------------------------------------------------------------------------- #
def _register_job(sched: Any, cfg: JobConfig) -> None:
    """把一个 task 配置注册为 cron job（id=配置 id，天然幂等可 replace）。"""
    from apscheduler.triggers.cron import CronTrigger

    sched.add_job(
        _run_job,
        CronTrigger.from_crontab(cfg.cron_expr),
        args=[cfg.id, JobTriggerSource.SCHEDULED],
        id=str(cfg.id),
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
        replace_existing=True,
    )


async def start_scheduler() -> None:
    """应用启动时调用：受 SCHEDULER_ENABLED 总开关控制，加载库中 enabled 任务注册。"""
    global _scheduler
    settings = get_settings()
    if not settings.SCHEDULER_ENABLED:
        return
    if _scheduler is not None:
        return
    from apscheduler.schedulers.asyncio import AsyncIOScheduler

    sched = AsyncIOScheduler()
    sched.start()
    _scheduler = sched
    await reload_schedule()


async def reload_schedule() -> None:
    """任务增删改 / 启停后调用：移除全部 job 并按库重载，使调度与 DB 保持一致。"""
    settings = get_settings()
    if not settings.SCHEDULER_ENABLED or _scheduler is None:
        return
    sched = _scheduler
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
    asyncio.get_running_loop().create_task(
        _run_job(job_id, JobTriggerSource.MANUAL)
    )


def shutdown_scheduler() -> None:
    """应用关闭时调用：停止并释放调度器。"""
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)  # type: ignore[attr-defined]
        _scheduler = None