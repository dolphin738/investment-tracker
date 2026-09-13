"""core 层「错误日志落库」能力的依赖倒置接口（core 不得依赖业务层）。

背景：有两个 core 组件都需要把错误写进 ``app_logs`` ——
- ``core/exceptions.py`` 的全局 5xx 处理器（``unhandled_exception_handler``）；
- ``core/bg.py`` 的后台任务 done-callback（``_do_record``）。

而 ``app_logs`` 的写入实现（``app.services.log.record``）位于 services 层，且
``services.log`` 自身依赖 ``models.log``；core 反向依赖业务层会违反
import-linter 契约 ``core_no_business``。

历史做法是在 ``.importlinter`` 给这两处各开一个 ``ignore_imports`` 单点豁免，
本质是「承认越界」。现改为**依赖倒置**：core 只声明钩子，实现由非 core 层
在**应用装配期**（``app/main.py``）注入，core 侧零业务依赖、契约零豁免。

未注入时（单测 / 脚本 / 装配前）``emit_error_log`` 静默跳过 —— 落库是尽力而为，
绝不能反过来影响主流程（例如让 500 响应或任务收尾因写日志失败而崩溃）。
"""
from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

# sink 签名与 ``app.services.log.record`` 对齐（关键字调用）：
# level / scope / module / message / trace / detail / user_id
ErrorLogSink = Callable[..., Awaitable[None]]

_sink: Optional[ErrorLogSink] = None


def set_error_log_sink(sink: Optional[ErrorLogSink]) -> None:
    """注入错误日志落库实现（传 ``None`` 可清除）。

    只应由**非 core 层**在应用装配期调用，典型实现是 ``app.services.log.record``。
    """
    global _sink
    _sink = sink


def get_error_log_sink() -> Optional[ErrorLogSink]:
    """返回当前已注入的 sink（未注入为 ``None``）；供测试断言注入状态。"""
    return _sink


async def emit_error_log(**kwargs: Any) -> None:
    """按已注入的 sink 落库；**未注入**或落库本身失败一律静默吞掉。

    调用方（core 组件）因此无需再包 try/except —— 落库失败不影响主流程，
    仅在 core 侧打一条 warning 便于排查。
    """
    sink = _sink
    if sink is None:
        return
    try:
        await sink(**kwargs)
    except Exception:  # noqa: BLE001  落库失败绝不反向污染主流程
        logger.warning("错误日志落库失败（不影响主流程）", exc_info=True)
