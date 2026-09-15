"""应用级日志初始化单测（T1-a）——幂等 / 格式 / 非法 level 回退 INFO。

背景（问题 3）：后端此前从未配置 logging handler，``app.services.*`` 的 warning 只走 root
的 ``lastResort``，输出**只有 message、无时间戳、无 level**（现场日志即如此），事后无法自证。
本文件守护 ``app.core.logging_setup.setup_logging`` 的幂等性、格式与回退行为。

⚠️ 本文件会改动 root logger 的 handlers / level，必须**先快照、finally 恢复**，
避免污染其它测试与 pytest 的 logging 插件（见 ``_isolate_root_logger`` 夹具）。
"""
from __future__ import annotations

import logging
import re

import pytest

from app.core.logging_setup import _APP_LOG_HANDLER_ATTR, setup_logging


def _app_handlers(root: logging.Logger) -> list[logging.Handler]:
    """root 上由本模块安装的 handler（凭标识属性识别）。"""
    return [h for h in root.handlers if getattr(h, _APP_LOG_HANDLER_ATTR, False)]


@pytest.fixture
def _isolate_root_logger():
    """快照 root 的 handlers / level，测试前移除本模块已装的 handler，结束后原样恢复。

    之所以移除再装：本模块的 ``setup_logging`` 幂等（已装则不重复装），若不清场就测不出
    「连续调用只装 1 个」。
    """
    root = logging.getLogger()
    snapshot_handlers = list(root.handlers)
    snapshot_level = root.level
    for h in _app_handlers(root):
        root.removeHandler(h)
    try:
        yield root
    finally:
        for h in _app_handlers(root):  # 清掉本测试装的
            root.removeHandler(h)
        for h in snapshot_handlers:  # 还原快照（补回被移除的）
            if h not in root.handlers:
                root.addHandler(h)
        root.setLevel(snapshot_level)


def test_setup_logging_is_idempotent(_isolate_root_logger):
    """幂等：连续调用 ``setup_logging()`` 2 次 → root 上该 handler 数量仍为 1。"""
    root = _isolate_root_logger
    setup_logging()
    setup_logging()
    assert len(_app_handlers(root)) == 1


def test_setup_logging_format_has_timestamp_level_and_logger_name(_isolate_root_logger):
    """格式：格式化的记录含时间戳（形如 ``2026-09-15 22:00:00``）、``WARNING``、logger 名。"""
    root = _isolate_root_logger
    setup_logging()
    handlers = _app_handlers(root)
    assert len(handlers) == 1

    record = logging.LogRecord(
        name="app.services.market_daily_price_sync",
        level=logging.WARNING,
        pathname=__file__,
        lineno=1,
        msg="收盘价批次 800 只请求异常 ConnectTimeout，重试",
        args=(),
        exc_info=None,
    )
    out = handlers[0].formatter.format(record)
    assert "WARNING" in out
    assert "app.services.market_daily_price_sync" in out
    assert re.search(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", out), out  # 时间戳


def test_setup_logging_invalid_level_falls_back_to_info(_isolate_root_logger):
    """非法 level 回退 INFO，且**不抛异常**。"""
    root = _isolate_root_logger
    setup_logging("NOT_A_REAL_LEVEL")  # 不应抛错
    assert root.level == logging.INFO


def test_setup_logging_none_keeps_info(_isolate_root_logger):
    """``level=None`` → 保持 INFO。"""
    root = _isolate_root_logger
    setup_logging(None)
    assert root.level == logging.INFO
