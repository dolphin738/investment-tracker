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

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.quote_interface import QuoteInterface


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
        """列出全部接口（扁平，供顶层按分类汇总总览）。按提供方 + 分类 + 名称排序。"""
        result = await self.session.execute(
            select(QuoteInterface).order_by(
                QuoteInterface.provider_id,
                QuoteInterface.category_id,
                QuoteInterface.name,
            )
        )
        return list(result.scalars().all())

    async def get(self, interface_id: str) -> Optional[QuoteInterface]:
        return await self.session.get(QuoteInterface, interface_id)

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
        for key, value in opts.items():
            if value is not None:
                setattr(obj, key, value)
        await self.session.flush()
        await self.session.refresh(obj)
        return obj

    async def delete(self, obj: QuoteInterface) -> None:
        await self.session.delete(obj)
        await self.session.flush()
