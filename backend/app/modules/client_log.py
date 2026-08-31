"""客户端日志采集端点 — 供前端错误/异常上报落库（方案 §4.2 / §7.2-2）。

前端 ``main.ts`` 全局错误捕获、``api-client`` 失败分支、``unhandledrejection``
监听都会调用本端点，把浏览器侧错误写入 ``app_logs``（scope='client'）。

鉴权：仅要求已登录（任意角色，含普通 user），因为普通用户的浏览器也可能产生
未捕获异常；写入时带上当前用户 id，便于回溯。读接口仍在 ``log_center`` 中由
admin/auditor 守卫，互不影响。
"""
from __future__ import annotations

from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.core.envelope import EnvelopeRoute
from app.services.auth import CurrentUser, get_current_user
from app.services.log import record

router_client_log = APIRouter(
    prefix="/api/client-logs", tags=["client"], route_class=EnvelopeRoute
)


class ClientLogIn(BaseModel):
    """前端上报的一条客户端错误。"""

    level: Literal["error", "warning", "info"] = "error"
    module: str
    message: str
    trace: Optional[str] = None
    detail: Optional[Any] = None


@router_client_log.post("")
async def ingest_client_log(
    payload: ClientLogIn,
    current: CurrentUser = Depends(get_current_user),
) -> dict:
    """接收前端上报的客户端错误并写入 ``app_logs``。

    落库失败由 ``record`` 内部吞掉，绝不影响主流程（上报本身就是 best-effort）。
    始终返回 ``{"ok": True}``，避免前端因上报失败而二次异常。
    """
    await record(
        level=payload.level,
        scope="client",
        module=payload.module,
        message=payload.message,
        trace=payload.trace,
        detail=payload.detail,
        user_id=current.user_id,
    )
    return {"ok": True}
