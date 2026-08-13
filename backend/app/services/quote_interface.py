"""提供方接口服务 — 证券行情数据提供方下的接口 CRUD + 顶层汇总。

与 QuoteProviderService 保持一致的风格：
- list_by_provider / list_all / get / create / update / delete。
- create/update 用关键字参 + Optional 局部更新（None 表示「未提供」）。
- provider 是否存在由路由层在 create 前校验（不存在 → 404）。

list_all() 供「按分类汇总所有提供方接口」总览：
- 后端扁平返回当前管理员可见的全部接口（复用 require_admin + EnvelopeRoute + 信封），
- 与现有 GET /api/admin/quote-providers/{provider_id}/interfaces 路径不冲突。
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy import func, nullslast, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.quote_interface import QuoteInterface
from app.services.interface_category import InterfaceCategoryService


class QuoteInterfaceService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def list_by_provider(self, provider_id: str) -> list[QuoteInterface]:
        """列出某提供方全部接口，按 category_id + name 排序。"""
        result = await self.session.execute(
            select(QuoteInterface)
            .where(QuoteInterface.provider_id == provider_id)
            .order_by(QuoteInterface.category_id, QuoteInterface.name)
        )
        return list(result.scalars().all())

    async def list_all(self) -> list[QuoteInterface]:
        """列出全部接口（扁平，供顶层按分类汇总总览）。

        排序：分类优先，分类内按 priority 升序（NULL 沉底），最后以 name 兜底。
        必须按 priority 排序，否则拖拽调序写入后重拉仍按 name 弹回，视觉无变化
        （ADR-002 §5.3 拖拽调序链路的读路径）。
        """
        result = await self.session.execute(
            select(QuoteInterface).order_by(
                QuoteInterface.category_id,
                nullslast(QuoteInterface.priority),
                QuoteInterface.name,
            )
        )
        return list(result.scalars().all())

    async def get(self, interface_id: str) -> Optional[QuoteInterface]:
        return await self.session.get(QuoteInterface, interface_id)

    async def _next_priority(self, category_id: Optional[str]) -> Optional[int]:
        """计算某分类下新接口的落位优先级：COALESCE(MAX(priority), -1) + 1。

        未分类（category_id=None）返回 None（留 NULL）；分类内无接口时返回 0。
        """
        if category_id is None:
            return None
        row = (
            await self.session.execute(
                select(func.max(QuoteInterface.priority)).where(
                    QuoteInterface.category_id == category_id
                )
            )
        ).scalar()
        base = -1 if row is None else row
        return base + 1

    async def reorder(self, category_id: str, ordered_ids: list[str]) -> None:
        """同分类内按传入的完整有序 id 列表重排 priority = index。

        校验：ordered_ids 中每个 id 都必须属于同一个 category_id，否则抛 400
        （不允许把接口挪到别的分类链，也不允许混入不存在的 id）。
        要求前端传入该分类完整接口 id 列表（含未启用），避免悬挂优先级歧义。
        """
        if not ordered_ids:
            return
        result = await self.session.execute(
            select(QuoteInterface.id, QuoteInterface.category_id).where(
                QuoteInterface.id.in_(ordered_ids)
            )
        )
        rows = result.all()
        found_ids = {r[0] for r in rows}
        # 任一 id 不存在 → 视为非法请求
        if set(ordered_ids) - found_ids:
            raise HTTPException(status_code=400, detail="存在不存在的接口 id")
        # 任一 id 不属于该分类 → 跨分类混入，拒绝
        for r in rows:
            if r[1] != category_id:
                raise HTTPException(
                    status_code=400, detail="存在不属于该分类的接口 id"
                )
        # 事务内批量重排：priority = 数组下标
        for idx, qid in enumerate(ordered_ids):
            await self.session.execute(
                update(QuoteInterface)
                .where(QuoteInterface.id == qid)
                .values(priority=idx)
            )
        await self.session.flush()

    async def create(
        self,
        *,
        provider_id: str,
        category_id: str,
        name: str,
        endpoint: Optional[str] = None,
        http_method: Optional[str] = None,
        params: Optional[dict[str, Any]] = None,
        enabled: bool = True,
        description: Optional[str] = None,
        direction: str = "in",
        timeout: Optional[int] = None,
        retry_count: Optional[int] = None,
        rate_limit: Optional[str] = None,
    ) -> QuoteInterface:
        # 写入前显式校验 category_id 指向真实存在的分类：
        # 不依赖 DB 外键报错翻译（那样会落到 500 兜底），这里主动映射成 4xx。
        category = await InterfaceCategoryService(self.session).get_or_none(category_id)
        if category is None:
            raise HTTPException(status_code=400, detail="分类不存在")
        # 默认优先级：落该分类末位（COALESCE(MAX(priority),-1)+1）；未分类留 NULL。
        priority = await self._next_priority(category_id)
        obj = QuoteInterface(
            provider_id=provider_id,
            category_id=category_id,
            name=name,
            endpoint=endpoint,
            http_method=http_method,
            params=params if params is not None else {},
            enabled=enabled,
            description=description,
            direction=direction,
            timeout=timeout,
            retry_count=retry_count,
            rate_limit=rate_limit,
            priority=priority,
        )
        self.session.add(obj)
        await self.session.flush()
        await self.session.refresh(obj)
        return obj

    async def update(
        self, obj: QuoteInterface, **opts: Any
    ) -> QuoteInterface:
        """局部更新：仅应用显式提供的字段（None 表示未提供，跳过）。

        注意 provider_id 不在更新范围内（接口归属不可改）。
        """
        # 若本次要写入新的 category_id（不为空），先校验其指向真实存在的分类。
        # 设为未分类（category_id=None）是允许的，无需校验。
        new_category_id = opts.get("category_id")
        if new_category_id is not None:
            category = await InterfaceCategoryService(self.session).get_or_none(new_category_id)
            if category is None:
                raise HTTPException(status_code=400, detail="分类不存在")
        for key, value in opts.items():
            if value is not None:
                setattr(obj, key, value)
        await self.session.flush()
        await self.session.refresh(obj)
        return obj

    async def delete(self, obj: QuoteInterface) -> None:
        await self.session.delete(obj)
        await self.session.flush()
