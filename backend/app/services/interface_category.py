"""接口分类服务 — 后台可配置的接口分类（列表 / 增改删）。

与 QuoteProviderService 保持一致的风格。分类无唯一业务键（仅 label + sort_order），
label 重复允许（UI 自行去重展示）。

分类删除保护：分类下已配置接口时禁止删除（400），需先移除接口或改分类；
仅空分类可删，故 QuoteInterface.category_id 外键的 ON DELETE SET NULL 实际不再
触发（外键定义保持不动，仅作为兜底约束）。
"""
from __future__ import annotations

from typing import Optional

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.interface_category import InterfaceCategory
from app.models.quote_interface import QuoteInterface


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

    async def interface_count(self, category_id: str) -> int:
        """统计某分类下已配置的接口数（供删除校验与列表展示复用）。"""
        return (
            await self.session.execute(
                select(func.count())
                .select_from(QuoteInterface)
                .where(QuoteInterface.category_id == category_id)
            )
        ).scalar_one()

    async def counts_by_category(self) -> dict[str, int]:
        """一次 group-by 查询批量取全部分类的接口数（供列表端点填充 interface_count）。"""
        rows = (
            await self.session.execute(
                select(QuoteInterface.category_id, func.count()).group_by(
                    QuoteInterface.category_id
                )
            )
        ).all()
        # category_id 可空（未分类接口），此处仅按非空分类聚合
        return {cid: cnt for cid, cnt in rows if cid is not None}

    async def delete(self, obj: InterfaceCategory) -> None:
        if obj.system:
            raise HTTPException(status_code=400, detail="系统内置分类不可删除")
        # 分类下已配置接口时禁止删除（需先移除或改分类），避免接口被静默置为未分类
        count = await self.interface_count(obj.id)
        if count > 0:
            raise HTTPException(
                status_code=400,
                detail=f"分类下已配置 {count} 个接口，需先移除或改分类后方可删除",
            )
        await self.session.delete(obj)
        await self.session.flush()
