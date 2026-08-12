"""接口分类服务 — 后台可配置的接口分类（列表 / 增改删）。

与 QuoteProviderService 保持一致的风格。key 唯一（UNIQUE 约束），重复插入/更新为已存在的
key 时捕获 IntegrityError → 抛 BusinessException(VALIDATION_FAILED, status_code=409)，
复用 2000 业务码（不新增业务码），由 envelope 归一为 409 / VALIDATION_FAILED(2000)。

分类删除不影响任何接口：QuoteInterface.interface_type 仅存自由文本 key，无外键约束。
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import BusinessErrorCode
from app.core.exceptions import BusinessException
from app.models.interface_category import InterfaceCategory


class InterfaceCategoryService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def list(self) -> list[InterfaceCategory]:
        """列出全部分类，按 sort_order 升序、其次 key。"""
        result = await self.session.execute(
            select(InterfaceCategory).order_by(
                InterfaceCategory.sort_order, InterfaceCategory.key
            )
        )
        return list(result.scalars().all())

    async def get(self, category_id: str) -> Optional[InterfaceCategory]:
        return await self.session.get(InterfaceCategory, category_id)

    async def create(
        self,
        *,
        key: str,
        label: str,
        icon: Optional[str] = None,
        sort_order: int = 0,
    ) -> InterfaceCategory:
        obj = InterfaceCategory(
            key=key, label=label, icon=icon, sort_order=sort_order
        )
        self.session.add(obj)
        try:
            await self.session.flush()
        except IntegrityError:
            await self.session.rollback()
            raise BusinessException(
                BusinessErrorCode.VALIDATION_FAILED,
                "接口分类 key 已存在",
                status_code=409,
            ) from None
        await self.session.refresh(obj)
        return obj

    async def update(
        self,
        obj: InterfaceCategory,
        *,
        key: Optional[str] = None,
        label: Optional[str] = None,
        icon: Optional[str] = None,
        sort_order: Optional[int] = None,
    ) -> InterfaceCategory:
        if key is not None:
            obj.key = key
        if label is not None:
            obj.label = label
        if icon is not None:
            obj.icon = icon
        if sort_order is not None:
            obj.sort_order = sort_order
        try:
            await self.session.flush()
        except IntegrityError:
            await self.session.rollback()
            raise BusinessException(
                BusinessErrorCode.VALIDATION_FAILED,
                "接口分类 key 已存在",
                status_code=409,
            ) from None
        await self.session.refresh(obj)
        return obj

    async def delete(self, obj: InterfaceCategory) -> None:
        await self.session.delete(obj)
        await self.session.flush()
