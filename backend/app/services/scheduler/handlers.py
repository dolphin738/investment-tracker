"""定时任务处理器注册表。

每个 handler 入参为 ``JobConfig``，返回执行摘要字符串；执行日志与运行状态由
``runner`` / ``lifecycle`` 统一落库与编排，handler 本身只负责业务执行。
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable

import httpx
from sqlalchemy import delete as sa_delete, func, select

from app.db.database import AsyncSessionLocal
from app.models import AppLog, JobConfig, JobRunLog, Notification
from app.models.enums import JobTaskType
from app.services.cleanup import CleanupService
from app.services.dividend_notice_scan import run_dividend_notice_scan
from app.services.dividend_sync import run_dividend_retention_cleanup
from app.services.dividend_yield_refresh import run_trade_calendar_refresh
from app.services.market_data_sync import MarketDataSyncService
from app.services.market_daily_price_sync import run_market_daily_close_fetch

from ._state import _HTTP_TIMEOUT


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
    # 股息率排名采集（§6，处理器在各自服务模块，此处仅薄注册）
    JobTaskType.MARKET_DAILY_CLOSE_FETCH: run_market_daily_close_fetch,
    JobTaskType.DIVIDEND_RETENTION_CLEANUP: run_dividend_retention_cleanup,
    JobTaskType.DIVIDEND_NOTICE_SCAN: run_dividend_notice_scan,
    # 交易日历刷新（系统任务，§5.5 防线一 / §7 stale 基准）
    JobTaskType.TRADE_CALENDAR_REFRESH: run_trade_calendar_refresh,
}
