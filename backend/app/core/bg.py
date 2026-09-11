"""fire-and-forget 后台任务的强引用持有器（全仓唯一实现）。

背景：Python asyncio 官方文档明确提示——**未持有引用的 Task 可能在完成前被 GC 回收**，
导致后台协程被静默取消（长耗时任务尤其危险）。本项目多处 fire-and-forget
（管理员手动触发任务、组合价格同步、股息率行情缺口回补）均适用。

统一落在 ``core`` 层的原因：纯 asyncio 基础设施、不依赖任何业务模块，
故 ``core_no_business`` 契约不受影响；同时避免各 router / service 各自
复制一份 ``_BG_TASKS`` / ``_track_task`` 造成多份漂移（历史上已漂移至 2 处，
新增端点再次漏用即回归，见 review-unpushed-2026-09-12 M-2）。
"""
from __future__ import annotations

import asyncio

_BG_TASKS: set[asyncio.Task] = set()


def track_task(task: asyncio.Task) -> asyncio.Task:
    """持有后台任务强引用，完成后自动从集合中移除（防 GC 提前回收）。

    兼作取出即用的兜底：``task.add_done_callback`` 依赖 Task 仍可被调用，
    故务必在 ``create_task`` 返回后立刻调用本函数，中间不要穿插 ``await``。

    返回原 Task，便于链式书写 ``track_task(asyncio.create_task(coro()))``。
    """
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)
    return task
