"""scheduler 包共享的模块级可变状态与常量。

这些符号在原 ``scheduler.py`` 中是模块级变量；拆成多文件后必须集中在单一模块，
否则各子模块的 ``global`` / 集合就地修改会指向不同对象，破坏 per-job / per-user 运行锁
与跨进程/跨模块共享的调度器引用。
"""
from __future__ import annotations

from typing import Optional

# 模块级唯一调度器引用，便于 shutdown 安全停止
_scheduler: Optional[object] = None

# HTTP 回调默认超时（秒）
_HTTP_TIMEOUT = 30

# 正在执行的 job_id 集合（per-job 运行锁：cron 与手动 trigger 并发去重，对齐 §6.1 防并发）
_running_job_ids: set[str] = set()

# 正在执行用户行情同步的 user_id 集合（并发去重：cron 与手动触发共用，防堆叠）
_running_user_syncs: set[str] = set()
