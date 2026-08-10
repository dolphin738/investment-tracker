"""资源 Service 共享基类与工具。

消除 routers/data.py 中 ≈14 处重复的「子实体归属校验」、重复的枚举强转与 id 解析。
各实体资源 Service 继承 PortfolioChildService，复用 get_scoped / coerce_enum / split_ids。

设计取舍（对标 app/ NestJS 但不过度）：
- NestJS 无通用 BaseService<T> 基类；此处基类仅做「去重」，不引入泛型仓储抽象。
- get_scoped 对应各资源 Service 私有 verifyOwnership 的统一版本（404 不泄露存在性）。
"""
from __future__ import annotations

from datetime import date
from typing import Optional, Type, TypeVar

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.date_utils import today_app_tz
from app.core.enums import BusinessErrorCode
from app.core.exceptions import BusinessException

ModelT = TypeVar("ModelT")


class PortfolioChildService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_scoped(self, model: Type[ModelT], id: str, portfolio_id: str) -> ModelT:
        """按 id 取子实体并校验归属：不存在或跨组合 → 404（不泄露存在性）。

        取代 routers/data.py 中重复的：
            obj = await db.get(Model, id)
            if obj is None or obj.portfolio_id != p.id:
                raise BusinessException(NOT_FOUND, ...)
        """
        obj = await self.session.get(model, id)
        if obj is None or obj.portfolio_id != portfolio_id:
            raise BusinessException(
                code=BusinessErrorCode.NOT_FOUND,
                message="资源不存在",
                status_code=404,
            )
        return obj


def coerce_enum(cls, val: str, field: str):
    """字符串 → 枚举；失败抛 VALIDATION_FAILED。

    对齐 routers/data.py _coerce 与 routers/dividend.py _coerce_dtype 的同构实现。
    """
    try:
        return cls(val)
    except ValueError:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message=f"{field} 取值无效：{val}",
            status_code=400,
        )


def split_ids(raw: Optional[str]) -> Optional[list[str]]:
    """逗号分隔 id 串 → 列表；空串/None → None。

    对齐 routers/data.py _split_ids 与 routers/calc.py 的同实现。
    """
    if not raw:
        return None
    return [x for x in raw.split(",") if x]


def validate_date_not_future(d: date) -> None:
    """拒绝未来日期（UTC+8 应用日口径，对齐 app/ validateDateNotFuture）。

    app/ 在 cashflow / security-trade / snapshot 的 create+patch（以及
    cash-balance / security-price 的 upsert）均做同等校验：当天允许，
    次日及以后拒绝。本 helper 统一收敛到 base，供各资源 Service 复用。
    """
    if d > today_app_tz():
        raise BusinessException(
            BusinessErrorCode.VALIDATION_FAILED,
            "日期不能为未来日期",
            status_code=400,
        )
