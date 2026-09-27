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
- ``reap_orphan_run_logs``：启动期回收孤儿 RUNNING 执行日志（进程被强杀遗留），闭环状态机。
- 每次执行（定时或手动）写入 ``job_run_logs``：RUNNING → SUCCESS/FAILED + 起止时间 + 信息。

设计取舍：
- 每个 handler 用独立的 ``AsyncSessionLocal`` 会话做业务，执行日志用单独会话写，互不干扰。
- 单个任务 cron 表达式非法仅跳过注册，不影响其余任务（异常由手动触发 / 列表日志暴露）。

本模块为门面包：原 ``app.services.scheduler`` 单文件拆分后，全部公开符号在此重导出，
保证 ``from app.services.scheduler import X`` 与 ``scheduler.X`` 两种引用方式均不变
（零行为变更），子模块实现见 ``.handlers`` / ``.runner`` / ``.user_sync`` / ``.lifecycle``。
"""
from __future__ import annotations

# 模块级状态别名（供测试隔离夹具 app.services.scheduler.AsyncSessionLocal 重绑）
from app.db.database import AsyncSessionLocal

from ._state import (
    _HTTP_TIMEOUT,
    _running_job_ids,
    _running_user_syncs,
    _scheduler,
)
from .handlers import (
    _HANDLERS,
    _accounts_cleanup,
    _http_callback,
    _log_cleanup,
    _security_master_sync,
)
from .runner import (
    _prune_run_logs,
    _run_job,
    _run_job_inner,
)
from .user_sync import (
    _run_user_quote_sync,
    run_user_sync_now,
)
from .lifecycle import (
    _register_job,
    _register_user_job,
    reload_schedule,
    run_task_now,
    shutdown_scheduler,
    start_scheduler,
)
from .reaper import reap_orphan_run_logs

__all__ = [
    "AsyncSessionLocal",
    "_HTTP_TIMEOUT",
    "_running_job_ids",
    "_running_user_syncs",
    "_scheduler",
    "_HANDLERS",
    "_accounts_cleanup",
    "_http_callback",
    "_log_cleanup",
    "_security_master_sync",
    "_prune_run_logs",
    "_run_job",
    "_run_job_inner",
    "_run_user_quote_sync",
    "run_user_sync_now",
    "_register_job",
    "_register_user_job",
    "reload_schedule",
    "run_task_now",
    "shutdown_scheduler",
    "start_scheduler",
    "reap_orphan_run_logs",
]
