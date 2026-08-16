"""接口分类服务 — 后台可配置的接口分类（列表 / 增改删）。

与 QuoteProviderService 保持一致的风格。分类无唯一业务键（仅 label + sort_order），
label 重复允许（UI 自行去重展示）。

分类删除不影响任何接口：QuoteInterface.category_id 外键 ON DELETE SET NULL，
删除分类仅把接口的 category_id 置 NULL，接口本身存活（变为「未分类」）。
"""
from __future__ import annotations

from typing import Optional

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.interface_category import InterfaceCategory


class InterfaceCategoryService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def list(self) -> list[InterfaceCategory]:
        """列出全部分类，按 sort_order 升序、其次 label。"""
        result = await self.session.execute(
            select(InterfaceCategory).order_by(
                InterfaceCategory.sort_order, InterfaceCategory.label
            )
        )
        return list(result.scalars().all())

    async def get(self, category_id: str) -> Optional[InterfaceCategory]:
        return await self.session.get(InterfaceCategory, category_id)

    async def get_or_none(self, category_id: str) -> Optional[InterfaceCategory]:
        """按 id 查询分类；缺失时返回 None（不抛异常）。

        用于「分类存在性预校验」场景：调用方据此主动映射成 4xx，
        避免误用 .get() 将来若改为 get-or-404 风格时误传播 404。
        """
        return await self.session.get(InterfaceCategory, category_id)

    async def create(
        self,
        *,
        label: str,
        icon: Optional[str] = None,
        sort_order: int = 0,
    ) -> InterfaceCategory:
        # 不可创建与已有系统内置分类同名的分类（分类即用途，系统分类不可被覆盖）
        dup = (
            await self.session.execute(
                select(InterfaceCategory).where(
                    InterfaceCategory.system == True,  # noqa: E712
                    InterfaceCategory.label == label,
                )
            )
        ).scalars().first()
        if dup is not None:
            raise HTTPException(
                status_code=400, detail="已存在同名系统分类，不可重复创建"
            )
        obj = InterfaceCategory(label=label, icon=icon, sort_order=sort_order)
        self.session.add(obj)
        await self.session.flush()
        await self.session.refresh(obj)
        return obj

    async def update(
        self,
        obj: InterfaceCategory,
        *,
        label: Optional[str] = None,
        icon: Optional[str] = None,
        sort_order: Optional[int] = None,
    ) -> InterfaceCategory:
        if label is not None:
            obj.label = label
        if icon is not None:
            obj.icon = icon
        if sort_order is not None:
            obj.sort_order = sort_order
        await self.session.flush()
        await self.session.refresh(obj)
        return obj

    async def delete(self, obj: InterfaceCategory) -> None:
        if obj.system:
            raise HTTPException(status_code=400, detail="系统内置分类不可删除")
        await self.session.delete(obj)
        await self.session.flush()
