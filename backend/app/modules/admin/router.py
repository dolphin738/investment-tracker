"""管理员路由 — 受角色保护的系统配置读写。

当前仅暴露证券行情 API 地址（securities_quote_api_base_url）的读 / 写：
- GET  /api/admin/system-config/{key}：读取（Depends(require_admin)）。
- PATCH /api/admin/system-config/{key}：upsert（Depends(require_admin)）。

安全约束：只允许白名单内的 key 写入 / 读取，避免任意键被写入或探测。
非白名单 key：GET 返回 404（不存在）、PATCH 返回 400（不被允许）。
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.envelope import EnvelopeRoute
from app.core.security import CurrentUser, require_admin
from app.db.database import get_db
from app.services.system_config import SystemConfigService


# 仅允许通过 admin 路由写入 / 读取的配置键白名单（纵深防御：避免任意键写入）
ALLOWED_CONFIG_KEYS: set[str] = {"securities_quote_api_base_url"}

router_admin = APIRouter(
    prefix="/api/admin", tags=["admin"], route_class=EnvelopeRoute
)


def _to_response(cfg) -> dict:
    return {
        "key": cfg.key,
        "value": cfg.config_value,
        "description": cfg.description,
        "updatedAt": cfg.updated_at,
    }


@router_admin.get("/system-config/{key}")
async def get_system_config(
    key: str,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if key not in ALLOWED_CONFIG_KEYS:
        raise HTTPException(status_code=404, detail="配置项不存在")
    svc = SystemConfigService(db)
    cfg = await svc.get(key)
    if cfg is None:
        raise HTTPException(status_code=404, detail="配置项不存在")
    return _to_response(cfg)


@router_admin.patch("/system-config/{key}")
async def update_system_config(
    key: str,
    value: dict[str, Any] = Body(...),
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """upsert 系统配置：请求体即配置的结构化值（形如 {"url": "..."}）。"""
    if key not in ALLOWED_CONFIG_KEYS:
        raise HTTPException(status_code=400, detail="不被允许的配置项")
    svc = SystemConfigService(db)
    cfg = await svc.set(key, value, current.user_id)
    await db.commit()
    await db.refresh(cfg)
    return _to_response(cfg)
