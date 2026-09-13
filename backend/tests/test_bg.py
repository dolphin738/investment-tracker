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


# ──────────────── 未捕获异常落日志中心 app_logs（1f17c0b） ────────────────
@pytest.mark.asyncio
async def test_do_record_writes_failure_to_log_center(monkeypatch):
    """_do_record 以 error 级写入日志中心，携带模块名 / 堆栈 / 异常类型。

    stderr 侧（logger.error）已有测试；这里守护「双写」的另一半：
    后台任务静默失败必须同时能在「系统管理 - 日志中心」里查到。
    """
    captured: dict = {}

    async def _fake_record(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr("app.services.log.record", _fake_record)

    await bg._do_record("backfill-prices", RuntimeError("数据源拒连"))

    assert captured["level"] == "error"
    assert captured["scope"] == "error"  # scope=error = 运行错误
    assert captured["module"] == "backfill-prices"
    assert "backfill-prices" in captured["message"]
    # 结构化附加信息：便于按异常类型检索
    assert captured["detail"]["exception_type"] == "RuntimeError"
    assert "数据源拒连" in captured["detail"]["exception_str"]
    # 堆栈已格式化（format_exception 产出），非空且含类型名
    assert "RuntimeError" in captured["trace"]


@pytest.mark.asyncio
async def test_track_task_records_failure_end_to_end(monkeypatch):
    """端到端：track_task 捕获的后台异常最终被投递到日志中心。"""
    captured: dict = {}

    async def _fake_record(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr("app.services.log.record", _fake_record)

    async def boom():
        raise ValueError("任务炸了")

    task = asyncio.create_task(boom(), name="bg-log-e2e")
    bg.track_task(task)
    # 让出控制权两轮：主协程结束 → done-callback → 再调度 _do_record 协程执行完
    for _ in range(20):
        await asyncio.sleep(0)

    assert captured.get("module") == "bg-log-e2e"
    assert captured.get("level") == "error"
    assert captured.get("detail", {}).get("exception_type") == "ValueError"


def test_record_task_failure_without_running_loop_is_noop(monkeypatch):
    """无运行中的事件循环（如进程关闭期）时静默返回，不得抛异常。

    落日志是「尽力而为」，绝不能反过来把关闭流程搞崩。
    """
    called: list = []

    async def _fake_record(**kwargs):
        called.append(kwargs)

    monkeypatch.setattr("app.services.log.record", _fake_record)

    # 同步上下文调用：内部 get_running_loop() 抛 RuntimeError，应被吞掉后直接 return
    bg._record_task_failure("no-loop", RuntimeError("x"))
    assert called == [], "无事件循环时不应尝试调用 record"
