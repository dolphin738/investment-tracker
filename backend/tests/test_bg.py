"""core.bg.fire-and-forget 强引用持有器 + 异常可观测单测。

守护 review-unpushed-2026-09-12 M-2 的修复：track_task 现在经 done-callback
回收未捕获异常并以 error 级记录；取消的任务属正常路径，不打错误日志。
"""
from __future__ import annotations

import asyncio
import logging

import pytest

from app.core import bg


@pytest.mark.asyncio
async def test_track_task_logs_uncaught_exception(caplog):
    """后台协程抛 RuntimeError，经 track_task 后 caplog 应捕获 error 级日志。"""

    async def boom():
        raise RuntimeError("回补任务炸了")

    task = asyncio.create_task(boom(), name="backfill-prices-test")
    bg.track_task(task)
    # 让出控制权，使协程执行完毕并触发 done-callback（避免 flaky）。
    for _ in range(5):
        await asyncio.sleep(0)

    assert task.done()
    error_logs = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert error_logs, "未捕获异常应产生 error 级日志"
    assert any("backfill-prices-test" in r.getMessage() for r in error_logs)
    assert any(r.exc_info is not None for r in error_logs)


@pytest.mark.asyncio
async def test_track_task_no_error_log_on_cancel(caplog):
    """被取消的任务属正常路径，不应产生 error 级日志。"""

    async def noop():
        await asyncio.sleep(10)

    task = asyncio.create_task(noop(), name="should-cancel")
    bg.track_task(task)
    task.cancel()
    # 让出控制权，使取消生效并触发 done-callback。
    for _ in range(5):
        await asyncio.sleep(0)

    assert task.cancelled()
    error_logs = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert not error_logs, "取消的任务不应产生 error 级日志"


@pytest.mark.asyncio
async def test_track_task_returns_original_task():
    """track_task 签名/返回值保持向后兼容：返回原 task。"""

    async def noop():
        return None

    task = asyncio.create_task(noop())
    assert bg.track_task(task) is task
    task.cancel()
    for _ in range(3):
        await asyncio.sleep(0)
