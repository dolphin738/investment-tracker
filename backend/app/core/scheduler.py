"""可选定时调度器 — 收盘后全量同步行情（APScheduler，默认关闭）。

设计约束（见 ADR-002 §5 第 5 步 / 任务清单 T06）：
- ``QUOTE_SYNC_SCHEDULER_ENABLED=False`` 时 ``start_scheduler`` 直接返回，
  不创建 ``BackgroundScheduler``、不注册 job，保证无 akshare / 未启用环境启动不报错。
- apscheduler 的 import 放在 ``start_scheduler`` 函数**内部**（懒导入），
  未安装 / 未启用时应用启动不会触碰 apscheduler。
- ``run_full_sync`` 用独立的 ``AsyncSessionLocal`` 会话遍历全部 Portfolio 调
  ``MarketDataSyncService.sync_portfolio_prices`` 并 commit（复用管理面全量同步逻辑）。
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import select

from app.core.config import get_settings
from app.db.database import AsyncSessionLocal
from app.models import Portfolio
from app.services.market_data_sync import MarketDataSyncService

# 模块级仅持有调度器引用，便于 shutdown 时安全停止
_scheduler: Optional[object] = None


async def run_full_sync() -> None:
    """全量同步全部组合的实时行情并重建快照/净值。

    先取全部 Portfolio.id，再逐组合开独立会话同步 + commit，避免长时间持有连接。
    """
    async with AsyncSessionLocal() as session:
        portfolio_ids = (
            await session.execute(select(Portfolio.id))
        ).scalars().all()
    for pid in portfolio_ids:
        async with AsyncSessionLocal() as s:
            await MarketDataSyncService(s).sync_portfolio_prices(pid)
            await s.commit()


def start_scheduler() -> None:
    """应用启动时调用：仅当启用且 akshare 可用时注册收盘后全量同步 job。"""
    global _scheduler
    settings = get_settings()
    if not settings.QUOTE_SYNC_SCHEDULER_ENABLED:
        return
    if _scheduler is not None:
        return
    # 懒导入：未安装 apscheduler / 未启用时绝不触发 import
    from apscheduler.schedulers.background import BackgroundScheduler
    from apscheduler.triggers.cron import CronTrigger

    sched = BackgroundScheduler()
    cron = CronTrigger.from_crontab(settings.QUOTE_SYNC_SCHEDULER_CRON)
    sched.add_job(run_full_sync, cron)
    sched.start()
    _scheduler = sched


def shutdown_scheduler() -> None:
    """应用关闭时调用：停止并释放调度器。"""
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)  # type: ignore[attr-defined]
        _scheduler = None
