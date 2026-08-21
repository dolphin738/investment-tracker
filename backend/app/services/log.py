"""统一日志服务 — 把一条日志写入 ``app_logs``（方案 §4.2）。

仅负责持久化落库；scope/level 的语义与何时调用由调用方决定（全局 5xx 异常处理器、
关键业务失败点等）。落库失败（如 DB 不可用）被吞掉，绝不影响主流程，尤其不能让
全局 5xx 响应因为写日志失败而再次异常。
"""
from __future__ import annotations

from typing import Any, Optional

from app.db.database import AsyncSessionLocal
from app.models.log import AppLog


async def record(
    level: str,
    scope: str,
    module: str,
    message: str,
    *,
    trace: Optional[str] = None,
    detail: Optional[Any] = None,
    user_id: Optional[str] = None,
) -> None:
    """写入一条 ``AppLog``。

    自建独立 ``AsyncSessionLocal`` 会话并提交，避免复用请求级会话在异常上下文中
    已处于失败 / 未完成态，导致日志写入污染主流程（如 5xx 响应）。

    Args:
        level: error | warning | info。
        scope: error | operation | system。
        module: 来源模块名（如 api / auth / scheduler）。
        message: 日志消息。
        trace: 可空，异常堆栈。
        detail: 可空，结构化附加信息（任意 JSON 可序列化对象）。
        user_id: 可空，关联用户 id。
    """
    try:
        async with AsyncSessionLocal() as session:
            log = AppLog(
                level=level,
                scope=scope,
                module=module,
                message=message,
                trace=trace,
                detail=detail,
                user_id=user_id,
            )
            session.add(log)
            await session.commit()
    except Exception:
        # 落库失败绝不影响主流程（如 500 响应）
        pass
