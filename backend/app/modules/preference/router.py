"""用户偏好路由（§4.2.16 · SET-P0-02）。

GET /api/users/preferences  → 取（不存在则建默认）偏好
PATCH /api/users/preferences → 全站唯一偏好写入口（部分更新 + 服务端白名单校验）
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.envelope import EnvelopeRoute
from app.services.auth import CurrentUser, get_current_user
from app.db.database import get_db
from app.serializers import serialize_preference
from app.schemas_resp import PreferenceOut
from app.services.preference import PreferenceService


ROUTER_PREFIX = "/api/users"


router = APIRouter(prefix=ROUTER_PREFIX, tags=["preference"], route_class=EnvelopeRoute)


@router.get("/preferences", response_model=PreferenceOut)
async def get_preferences(
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    pref = await PreferenceService(db).get_or_create(user.user_id)
    return serialize_preference(pref)


@router.patch("/preferences", response_model=PreferenceOut)
async def patch_preferences(
    body: dict,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    pref = await PreferenceService(db).patch(user.user_id, body)
    return serialize_preference(pref)
