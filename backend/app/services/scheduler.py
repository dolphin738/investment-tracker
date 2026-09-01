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
from sqlalchemy import delete as sa_delete, func, select

from app.core.config import get_settings
from app.db.database import AsyncSessionLocal
from app.models import (
    AppLog,
    JobConfig,
    JobRunLog,
    Notification,
    Portfolio,
    UserQuoteSyncConfig,
)
from app.models.enums import JobRunStatus, JobTaskType, JobTriggerSource
from app.services.cleanup import CleanupService
from app.services.market_data_sync import MarketDataSyncService

# 模块级唯一调度器引用，便于 shutdown 安全停止
_scheduler: Optional[object] = None

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


async def _log_cleanup(cfg: JobConfig) -> str:
    """按级别分级清理日志中心（方案 §4.6）。

    - app_logs：每 level 执行「过期删除」+「超量删除」两条规则；
    - notifications：仅删「已读且超期」行，未读永不删；
    - job_run_logs：仅清理「未配置 max_logs」任务的超期执行日志（默认 30 天）。

    用独立 ``AsyncSessionLocal`` 会话（对齐 log_service.record），整段 try/except 吞掉
    异常并把失败本身落库，避免清理任务自己炸。参数为空时回退到方案 §4.6 默认值。
    """
    from datetime import timedelta

    params = cfg.params or {}
    retention_days = params.get("retention_days") or {"error": 90, "warning": 30, "info": 7}
    max_rows = params.get("max_rows") or {"error": 20000, "warning": 10000, "info": 5000}
    notif_retention = int(params.get("notifications_retention_days") or 30)
    deleted_app = deleted_notif = deleted_job = 0
    try:
        async with AsyncSessionLocal() as session:
            now = datetime.now(timezone.utc)
            # 1) app_logs：逐 level 过期 + 超量
            for level in ("error", "warning", "info"):
                days = int(retention_days.get(level, 7))
                res = await session.execute(
                    sa_delete(AppLog).where(
                        AppLog.level == level,
                        AppLog.created_at < now - timedelta(days=days),
                    )
                )
                deleted_app += res.rowcount or 0
                limit = int(max_rows.get(level, 5000))
                total = (
                    await session.execute(
                        select(func.count())
                        .select_from(AppLog)
                        .where(AppLog.level == level)
                    )
                ).scalar_one()
                if total > limit:
                    excess = total - limit
                    stale_ids = (
                        await session.execute(
                            select(AppLog.id)
                            .where(AppLog.level == level)
                            .order_by(AppLog.created_at.asc(), AppLog.id.asc())
                            .limit(excess)
                        )
                    ).scalars().all()
                    if stale_ids:
                        await session.execute(
                            sa_delete(AppLog).where(AppLog.id.in_(stale_ids))
                        )
                        deleted_app += len(stale_ids)
            await session.commit()

            # 2) notifications：仅删「已读且超期」行，未读永不删
            res = await session.execute(
                sa_delete(Notification).where(
                    Notification.read == True,  # noqa: E712
                    Notification.created_at < now - timedelta(days=notif_retention),
                )
            )
            deleted_notif += res.rowcount or 0

            # 3) job_run_logs：仅清理「未配置 max_logs（NULL）」任务的超期日志（默认 30 天）
            res = await session.execute(
                sa_delete(JobRunLog)
                .where(JobRunLog.started_at < now - timedelta(days=30))
                .where(
                    JobRunLog.job_id.in_(
                        select(JobConfig.id).where(JobConfig.max_logs.is_(None))
                    )
                )
            )
            deleted_job += res.rowcount or 0
            await session.commit()
    except Exception as exc:  # 清理失败本身落库，不让清理任务自己炸
        try:
            from app.services.log import record

            await record("error", "system", "scheduler", f"日志清理失败：{exc}")
        except Exception:
            pass
        raise

    summary = (
        f"日志清理完成：删 app_logs {deleted_app} 条、"
        f"notifications {deleted_notif} 条、job_logs {deleted_job} 条"
    )
    try:
        from app.services.log import record

        await record("info", "system", "scheduler", summary)
    except Exception:
        pass
    return summary


async def _http_callback(cfg: JobConfig) -> str:
    """执行 HTTP 回调（params.url / method / body）。"""
    from app.core.url_guard import assert_safe_url, clamp_timeout

    params = cfg.params or {}
    url = (params.get("url") or "").strip()
    if not url:
        raise RuntimeError("HTTP_CALLBACK 任务缺少参数 url")
    # SSRF 防护：仅允许 http/https，且默认禁止环回/链路本地（防云元数据探测）
    assert_safe_url(url)
    method = (params.get("method") or "POST").upper()
    body = params.get("body")
    async with httpx.AsyncClient(timeout=clamp_timeout(_HTTP_TIMEOUT)) as client:
        resp = await client.request(method, url, json=body if isinstance(body, dict) else None)
    if resp.status_code >= 400:
        raise RuntimeError(f"HTTP 回调失败：{resp.status_code}")
    return f"HTTP {resp.status_code}"


_HANDLERS: dict[JobTaskType, Callable[[JobConfig], Any]] = {
    JobTaskType.SECURITY_MASTER_SYNC: _security_master_sync,
    JobTaskType.ACCOUNT_CLEANUP: _accounts_cleanup,
    JobTaskType.LOG_CLEANUP: _log_cleanup,
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


# --------------------------------------------------------------------------- #
# 用户级行情自动同步（每用户独立配置，只同步本人组合；不写 job_run_logs）
# --------------------------------------------------------------------------- #
# 正在执行用户行情同步的 user_id 集合（并发去重：cron 与手动触发共用，防堆叠）
_running_user_syncs: set[str] = set()


async def _run_user_quote_sync(user_id: str) -> None:
    """按用户配置同步其本人所属全部组合行情，并回写执行状态到 user_quote_sync_configs。

    逐组合用独立会话同步 + 提交；**单组合失败仅记录、不中断其余组合**；
    全部成功 → SUCCESS + "已同步 N 个组合"，任一失败 → FAILED + 错误摘要。
    执行结果不回写 job_run_logs。同一用户重复触发（手动连点/cron 撞上手动）直接跳过。
    """
    if user_id in _running_user_syncs:
        return
    _running_user_syncs.add(user_id)
    try:
        async with AsyncSessionLocal() as session:
            portfolio_ids = (
                await session.execute(
                    select(Portfolio.id).where(Portfolio.user_id == user_id)
                )
            ).scalars().all()
        count = 0
        errors: list[str] = []
        for pid in portfolio_ids:
            try:
                async with AsyncSessionLocal() as s:
                    await MarketDataSyncService(s).sync_portfolio_prices(pid)
                    await s.commit()
                count += 1
            except Exception as exc:  # 单组合失败不中断其余组合
                errors.append(f"{pid}: {exc}")
        async with AsyncSessionLocal() as session:
            cfg = await session.get(UserQuoteSyncConfig, user_id)
            if cfg is not None:
                cfg.last_run_at = datetime.now(timezone.utc)
                if not errors:
                    cfg.last_status = "SUCCESS"
                    cfg.last_message = f"已同步 {count} 个组合"
                else:
                    cfg.last_status = "FAILED"
                    cfg.last_message = (
                        f"同步 {count}/{len(portfolio_ids)} 个组合成功；"
                        f"失败明细：{'；'.join(errors)}"[:512]
                    )
                await session.commit()
    finally:
        _running_user_syncs.discard(user_id)


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