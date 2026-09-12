"""fire-and-forget 后台任务的强引用持有器（全仓唯一实现）。

背景：Python asyncio 官方文档明确提示——**未持有引用的 Task 可能在完成前被 GC 回收**，
导致后台协程被静默取消（长耗时任务尤其危险）。本项目多处 fire-and-forget
（管理员手动触发任务、组合价格同步、股息率行情缺口回补）均适用。

统一落在 ``core`` 层的原因：纯 asyncio 基础设施、不依赖任何业务模块，
故 ``core_no_business`` 契约不受影响；同时避免各 router / service 各自
复制一份 ``_BG_TASKS`` / ``_track_task`` 造成多份漂移（历史上已漂移至 2 处，
新增端点再次漏用即回归，见 review-unpushed-2026-09-12 M-2）。

``track_task`` 现在同时承担**异常可观测**职责：后台协程若抛出未捕获异常，
会经 done-callback 以 error 级日志记录（带堆栈）。否则后台任务静默失败
（"Task exception was never retrieved" 因强引用迟迟不触发甚至永不触发）
将无从发现。
"""
from __future__ import annotations

import asyncio
import logging

_BG_TASKS: set[asyncio.Task] = set()

logger = logging.getLogger(__name__)


def _on_task_done(task: asyncio.Task) -> None:
    """后台任务结束回调：先移除强引用，再回收并记录未捕获异常。

    顺序很重要——必须先 ``discard`` 解除对 task 的强引用，再读 ``exception()``，
    否则强引用可能让 asyncio "未取回异常" 警告延迟甚至永不触发。取消是正常路径，
    不打错误日志；其余未捕获异常一律 error 级记录，便于定位静默失败。
    """
    _BG_TASKS.discard(task)
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        logger.error(
            "后台任务 %s 抛未捕获异常（任务静默失败）",
            task.get_name(),
            exc_info=exc,
        )


def track_task(task: asyncio.Task) -> asyncio.Task:
    """持有后台任务强引用，完成后自动从集合中移除（防 GC 提前回收）。

    兼作取出即用的兜底：``task.add_done_callback`` 依赖 Task 仍可被调用，
    故务必在 ``create_task`` 返回后立刻调用本函数，中间不要穿插 ``await``。

    返回原 Task，便于链式书写 ``track_task(asyncio.create_task(coro()))``。

    本函数同时承担**异常可观测**职责：若后台协程抛出未捕获异常，会经
    done-callback 以 error 级日志记录（带堆栈），否则静默失败无从发现。
    """
    _BG_TASKS.add(task)
    task.add_done_callback(_on_task_done)
    return task
