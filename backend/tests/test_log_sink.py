"""core.log_sink —— 「错误日志落库」依赖倒置钩子的单测。

守护 core_no_business **零豁免**：core 侧不得 import 业务层，落库实现由
``app/main.py`` 在装配期注入。本文件覆盖钩子自身行为（未注入静默 / 注入转发 /
sink 失败静默 / 可清除），以及 app.main 是否真的完成了注入（否则 5xx 与后台任务
的落库会静默失效 —— 这正是「静默失败」最危险的形态）。
"""
from __future__ import annotations

import pytest

from app.core import log_sink


@pytest.mark.asyncio
async def test_emit_is_noop_when_no_sink(monkeypatch):
    """未注入 sink（单测 / 脚本 / 装配前）时静默返回：落库是尽力而为，不得抛异常。"""
    monkeypatch.setattr("app.core.log_sink._sink", None)

    # 不抛异常即通过
    await log_sink.emit_error_log(
        level="error", scope="error", module="x", message="m"
    )


@pytest.mark.asyncio
async def test_emit_forwards_kwargs_to_injected_sink(monkeypatch):
    """注入后按关键字**完整转发**：调用方（core 组件）无需感知具体实现。"""
    captured: dict = {}

    async def _sink(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr("app.core.log_sink._sink", _sink)

    await log_sink.emit_error_log(
        level="error", scope="error", module="api", message="boom", trace="tb"
    )

    assert captured == {
        "level": "error",
        "scope": "error",
        "module": "api",
        "message": "boom",
        "trace": "tb",
    }


@pytest.mark.asyncio
async def test_emit_swallows_sink_failure(monkeypatch):
    """sink 自身抛错（如 DB 不可用）必须被吞掉，否则会反向污染 500 响应 / 任务收尾。"""

    async def _boom(**kwargs):
        raise RuntimeError("DB down")

    monkeypatch.setattr("app.core.log_sink._sink", _boom)

    # 不抛异常即通过
    await log_sink.emit_error_log(
        level="error", scope="error", module="x", message="m"
    )


def test_set_and_clear_sink():
    """set_error_log_sink(None) 可清除注入，get 如实反映当前状态。"""
    original = log_sink.get_error_log_sink()
    try:
        log_sink.set_error_log_sink(None)
        assert log_sink.get_error_log_sink() is None
    finally:
        log_sink.set_error_log_sink(original)


def test_main_wires_error_log_sink():
    """app.main 装配期必须注入 services.log.record（依赖倒置的注入端）。

    若这条断言失败，说明生产路径下 5xx 与后台任务的落库会静默失效 —— 且因为
    emit_error_log 有意吞异常，故障将完全不可见，故必须由测试守住。
    """
    import app.main  # noqa: F401  触发装配期的模块级注入

    from app.services.log import record

    assert log_sink.get_error_log_sink() is record
