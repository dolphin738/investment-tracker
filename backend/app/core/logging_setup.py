"""应用级日志初始化 —— 让 ``app.*`` 的日志自带时间戳与级别（core 层，零业务依赖）。

背景（问题 3 — 可观测性缺口）：后端此前从未配置 logging handler（``app/main.py`` 仅注入
了「错误落库」sink）。于是 ``app.services.*`` 的 ``logger.warning`` 只能走 root 的 Python
``lastResort`` 兜底处理器——输出**只有 message、无时间戳、无 level**（2026-09-15 收盘价
故障现场日志 ``收盘价批次 800 只请求异常 ，重试`` 正是如此），事后无法据此自证故障发生的
时间与级别。本模块在**装配期**由 ``app/main.py`` 调用一次，给 root logger 安装一个带
时间戳/级别的 stderr handler，使应用日志（含 services 层）可被事后诊断。

设计约束：
- **只用标准库**：core 层不得依赖业务层（import-linter ``core_no_business`` 硬契约）；
- **幂等**：本机 dev 用 ``--reload``、``main`` 也可能被多次 import，重复调用**不得叠加
  handler**；用「模块级标记 + 为自己安装的 handler 打的标识属性」**二者结合**判断；
- **不用 ``logging.basicConfig``**：root 已有 handler 时它静默 no-op，不可靠；
- **不碰 uvicorn 的 logger**：``uvicorn*`` 自带 handler 且 ``propagate=False``，
  改它无意义且易与 uvicorn 自身配置打架；
- **import 期不执行配置**：只定义函数，由装配期显式调用；
- 不注册第三方 handler、不引入任何新依赖。
"""
from __future__ import annotations

import logging
import sys

# 标识属性：打在本模块安装的 handler 上，用于在 ``root.handlers`` 中识别「是不是我们装的」。
_APP_LOG_HANDLER_ATTR = "_app_log_handler"

_LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"
_LOG_DATEFMT = "%Y-%m-%d %H:%M:%S"

# 模块级标记：本模块是否已安装过 handler（与 _APP_LOG_HANDLER_ATTR 结合判断幂等）。
# 之所以两者结合、而非只看其一：单看模块标记会在「测试清理掉 handler」后误判为已配置、
# 导致真实应用启动时不再安装；单看 handler 属性又无「本模块曾配置过」的语义。
_configured = False
# 非法 level 只告警一次（避免重复调用刷屏）。
_invalid_level_warned = False

_logger = logging.getLogger(__name__)


def _has_app_handler(root: logging.Logger) -> bool:
    """root 上是否已存在本模块安装的 handler（凭标识属性识别）。"""
    return any(getattr(h, _APP_LOG_HANDLER_ATTR, False) for h in root.handlers)


def _resolve_level(level: "str | int | None") -> int:
    """把 ``level`` 解析为 logging 级别整数；非法值回退 INFO（只告警一次，不抛错）。

    - ``None`` → INFO（保持默认级别）；
    - ``int`` → 原样返回（调用方直接给了级别常量）；
    - ``str`` → ``getattr(logging, <大写名>, INFO)``；解析不出（非法名）时告警一次并回退
      INFO——**不抛错、也不静默无 log**（否则配置写错时日志级别会悄悄失真）。
    """
    if level is None:
        return logging.INFO
    if isinstance(level, int):
        return level
    name = str(level).upper()
    resolved = getattr(logging, name, None)
    if isinstance(resolved, int):
        return resolved
    global _invalid_level_warned
    if not _invalid_level_warned:
        _invalid_level_warned = True
        _logger.warning("非法日志级别 %r，回退 INFO", level)
    return logging.INFO


def setup_logging(level: "str | int | None" = None) -> None:
    """在 root logger 上安装带时间戳/级别的 stderr handler（**幂等**）。

    安装的 handler 格式为 ``%(asctime)s %(levelname)s %(name)s: %(message)s``、
    时间格式为 ``%Y-%m-%d %H:%M:%S``，输出到 ``sys.stderr``。这样 ``app.services.*``
    的 ``logger.warning`` 才带时间戳与级别（不再退化成只有 message 的空壳）。

    Args:
        level: 期望的 root 日志级别；``None`` 表示保持 INFO。支持级别名（如 ``"INFO"``）
            或 logging 级别整数；非法名回退 INFO 且只告警一次。

    幂等性：当且仅当「本模块此前已配置过（``_configured``）」**且**「root 上仍存在本模块
    安装的 handler（标识属性）」时直接返回——二者结合既防重复叠加（``--reload`` / 多次
    import），又能在测试清理掉 handler 后重新安装（避免「标记为真但无 handler」的假配置）。
    root 的**级别每次都幂等设置**（即便提前返回也生效），保证级别配置不因幂等而失效。
    """
    global _configured
    root = logging.getLogger()
    if not (_configured and _has_app_handler(root)):
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(logging.Formatter(_LOG_FORMAT, datefmt=_LOG_DATEFMT))
        # 打标识属性：后续调用据此识别「是本模块装的」，避免重复叠加。
        setattr(handler, _APP_LOG_HANDLER_ATTR, True)
        root.addHandler(handler)
        _configured = True
    # 幂等设置 root 级别（提前返回路径同样生效，便于「非法 level 回退 INFO」断言）。
    root.setLevel(_resolve_level(level))
