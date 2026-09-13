"""fire-and-forget 后台任务的强引用持有器（全仓唯一实现）。

背景：Python asyncio 官方文档明确提示——**未持有引用的 Task 可能在完成前被 GC 回收**，
导致后台协程被静默取消（长耗时任务尤其危险）。本项目多处 fire-and-forget
（管理员手动触发任务、组合价格同步、股息率行情缺口回补）均适用。

统一落在 ``core`` 层的原因：纯 asyncio 基础设施，且避免各 router / service 各自
复制一份 ``_BG_TASKS`` / ``_track_task`` 造成多份漂移（历史上已漂移至 2 处，
新增端点再次漏用即回归，见 review-unpushed-2026-09-12 M-2）。

**依赖倒置（core_no_business 零豁免）**：本模块落 app_logs **不**直接 import
``app.services.log``，而是调用 ``core/log_sink.emit_error_log``；真正的落库实现
由 ``app/main.py`` 在装配期注入（详见 ``core/log_sink.py``）。故 core 侧零业务依赖，
``.importlinter`` 无需任何豁免。

``track_task`` 现在同时承担**异常可观测**职责：后台协程若抛出未捕获异常，
会经 done-callback 以 error 级日志记录（带堆栈）。否则后台任务静默失败
（"Task exception was never retrieved" 因强引用迟迟不触发甚至永不触发）
将无从发现。
"""
from __future__ import annotations

import asyncio
import logging
import traceback

from app.core.log_sink import emit_error_log

_BG_TASKS: set[asyncio.Task] = set()

logger = logging.getLogger(__name__)


def _record_task_failure(name: str, exc: BaseException) -> None:
    """把后台任务未捕获异常落到日志中心（app_logs），与 stderr 双写。

    在事件循环线程的 done-callback 中调用，故用当前运行中的 loop 调度 ``record``
    协程；``record`` 自建会话写库、失败静默吞掉，不会反向污染主流程。用模块级集合
    持有该落库任务的强引用，避免被 GC 提前回收（与 _BG_TASKS 同款防回收语义）。
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # 无运行中的事件循环（如进程关闭期）：放弃落库，stderr 侧已记录
        return
    log_task = loop.create_task(_do_record(name, exc))
    _BG_TASKS.add(log_task)
    log_task.add_done_callback(lambda t: _BG_TASKS.discard(t))


async def _do_record(name: str, exc: BaseException) -> None:
    """把后台任务未捕获异常交给已注入的日志落库 sink（见 ``core/log_sink``）。

    本模块**不**直接依赖 services（``core_no_business`` 契约）：sink 由
    ``app/main.py`` 装配期注入 ``services.log.record``，未注入时静默跳过。
    ``emit_error_log`` 自身已吞掉落库异常，故此处无需再包 try/except。
    """
    await emit_error_log(
        level="error",
        scope="error",
        module=name,
        message=f"后台任务 {name} 抛未捕获异常（任务静默失败）",
        trace="".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
        detail={
            "exception_type": type(exc).__name__,
            "exception_str": str(exc),
        },
    )


def _on_task_done(task: asyncio.Task) -> None:
    """后台任务结束回调：先移除强引用，再回收并记录未捕获异常。

    顺序很重要——必须先 ``discard`` 解除对 task 的强引用，再读 ``exception()``，
    否则强引用可能让 asyncio "未取回异常" 警告延迟甚至永不触发。取消是正常路径，
    不打错误日志；其余未捕获异常一律 error 级记录（stderr + 日志中心 app_logs），
    便于定位静默失败。
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
        _record_task_failure(task.get_name(), exc)


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
