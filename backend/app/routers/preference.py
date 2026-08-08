"""用户偏好路由（§4.2.16 · SET-P0-02）。

GET /api/users/preferences  → 取（不存在则建默认）偏好
PATCH /api/users/preferences → 全站唯一偏好写入口（部分更新 + 服务端白名单校验）
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import BusinessErrorCode
from app.core.envelope import EnvelopeRoute
from app.core.exceptions import BusinessException
from app.core.security import CurrentUser, get_current_user
from app.db.database import get_db
from app.models import UserPreference
from app.routers.common import serialize_preference


# 服务端白名单（裁决 Q-5：保持 String + 校验，零 migration）
_DATE_RANGES = ["1w", "1m", "3m", "6m", "1y", "ytd", "all"]
_GRANULARITIES = ["day", "week", "month", "quarter", "year"]
_AGGREGATIONS = ["last", "avg"]
_THEMES = ["system", "light", "dark"]

ROUTER_PREFIX = "/api/users"


router = APIRouter(prefix=ROUTER_PREFIX, tags=["preference"], route_class=EnvelopeRoute)


async def _get_or_create(db: AsyncSession, user_id: str) -> UserPreference:
    pref = (
        await db.execute(
            select(UserPreference).where(UserPreference.user_id == user_id)
        )
    ).scalar_one_or_none()
    if pref is None:
        pref = UserPreference(user_id=user_id)
        db.add(pref)
        await db.commit()
        await db.refresh(pref)
    return pref


def _validate(field: str, value: str, allowed: list[str]) -> None:
    if value not in allowed:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message=f"{field} 取值无效：{value}（允许 {', '.join(allowed)}）",
            status_code=400,
        )


@router.get("/preferences")
async def get_preferences(
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    pref = await _get_or_create(db, user.user_id)
    return serialize_preference(pref)


@router.patch("/preferences")
async def patch_preferences(
    body: dict,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    pref = await _get_or_create(db, user.user_id)

    # 白名单字段（防止任意列注入）
    allowed = {
        "defaultPortfolioId",
        "defaultGranularity",
        "defaultDateRange",
        "aggregation",
        "weekStartsOn",
        "navDecimals",
        "xirrDecimals",
        "theme",
        "staleDays",
        "showLiquidated",
        "costBasisView",
        "cashHintOnCashflow",
        "cashHintOnTrade",
        "amountThousands",
        "amountAbbrev",
    }
    unknown = set(body.keys()) - allowed
    if unknown:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message=f"未知偏好字段：{', '.join(sorted(unknown))}",
            status_code=400,
        )

    for key, value in body.items():
        if value is None:
            continue
        if key == "defaultDateRange":
            _validate("defaultDateRange", value, _DATE_RANGES)
        elif key == "defaultGranularity":
            _validate("defaultGranularity", value, _GRANULARITIES)
        elif key == "aggregation":
            _validate("aggregation", value, _AGGREGATIONS)
        elif key == "theme":
            _validate("theme", value, _THEMES)
        # 其余字段按类型直接赋值（由 ORM/DB 约束保证合法）
        setattr(pref, _snake(key), value)

    await db.commit()
    await db.refresh(pref)
    return serialize_preference(pref)


def _snake(camel: str) -> str:
    out = []
    for ch in camel:
        if ch.isupper():
            out.append("_")
            out.append(ch.lower())
        else:
            out.append(ch)
    return "".join(out)
