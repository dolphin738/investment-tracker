"""契约验证用演示路由（Phase 0）。

覆盖：成功信封、Decimal→str、data=null、业务异常码、JWT 鉴权、DecimalStr DTO。
后续 Phase 会在独立 router 中实现真实业务模块，本文件保留为契约冒烟点。
"""
from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.core.enums import BusinessErrorCode
from app.core.envelope import EnvelopeRoute
from app.core.exceptions import BusinessException
from app.core.security import CurrentUser, get_current_user
from app.core.types import DecimalStr

# 所有业务 router 必须用 EnvelopeRoute，才能自动包信封
router = APIRouter(prefix="/api", tags=["contract"], route_class=EnvelopeRoute)


class AmountDTO(BaseModel):
    amount: DecimalStr
    fee: DecimalStr


@router.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "investment_return_tracker"}


@router.get("/empty")
async def empty() -> None:
    # 验证 data 为 None 时归一为 null
    return None


@router.get("/echo")
async def echo() -> dict:
    # 验证裸 Decimal 在信封 data 中序列化为字符串（非 number）
    return {"amount": Decimal("1234.50"), "name": "demo"}


@router.get("/decimal-model")
async def decimal_model() -> AmountDTO:
    # 验证 DTO 中 DecimalStr 字段序列化为字符串
    return AmountDTO(amount=Decimal("999.99"), fee=Decimal("0.05"))


@router.get("/protected")
async def protected(user: CurrentUser = Depends(get_current_user)) -> dict:
    return {"user_id": user.user_id, "email": user.email}


@router.get("/boom")
async def boom() -> None:
    # 验证业务异常 → 信封 { code: 3001, data: null, message }
    raise BusinessException(
        code=BusinessErrorCode.NOT_FOUND,
        message="组合不存在",
        status_code=404,
    )
