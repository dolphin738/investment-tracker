"""证券行情数据提供方服务 — 多提供方管理 CRUD。

- list / get / create / update / delete：受 admin 路由保护的 CRUD。
- 全局单一活跃源（is_default / is_active + set_default / set_active /
  get_active_provider）已完全移除（ADR-002 方案 X）：提供方仅保留 `enabled`
  启停开关，运行时选源由 `MarketDataSyncService.fallback_fetch` 按分类级接口
  优先级链解析，不再经由本服务。

名称唯一性（大小写不敏感）由 create/update 显式查重保证。
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.quote_provider import SecuritiesDataProvider


class QuoteProviderService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def list(self) -> list[SecuritiesDataProvider]:
        result = await self.session.execute(
            select(SecuritiesDataProvider).order_by(SecuritiesDataProvider.created_at)
        )
        return list(result.scalars().all())

    async def get(self, provider_id: str) -> Optional[SecuritiesDataProvider]:
        return await self.session.get(SecuritiesDataProvider, provider_id)

    async def create(
        self,
        *,
        name: str,
        access_method: str,
        config: dict,
        enabled: bool = True,
        description: Optional[str] = None,
    ) -> SecuritiesDataProvider:
        # 名称唯一性：禁止与现有提供方重名（大小写不敏感）
        dup = (
            await self.session.execute(
                select(SecuritiesDataProvider).where(
                    func.lower(SecuritiesDataProvider.name) == func.lower(name)
                )
            )
        ).scalar_one_or_none()
        if dup is not None:
            raise ValueError("已存在同名数据来源，请更换名称")
        provider = SecuritiesDataProvider(
            name=name,
            access_method=access_method,
            config=config,
            enabled=enabled,
            description=description,
        )
        self.session.add(provider)
        await self.session.flush()
        await self.session.refresh(provider)
        return provider

    async def update(
        self,
        provider: SecuritiesDataProvider,
        *,
        name: Optional[str] = None,
        access_method: Optional[str] = None,
        config: Optional[dict] = None,
        enabled: Optional[bool] = None,
        description: Optional[str] = None,
    ) -> SecuritiesDataProvider:
        if name is not None:
            # 重命名时禁止与「其它」提供方重名（大小写不敏感，排除自身）
            dup = (
                await self.session.execute(
                    select(SecuritiesDataProvider).where(
                        func.lower(SecuritiesDataProvider.name) == func.lower(name),
                        SecuritiesDataProvider.id != provider.id,
                    )
                )
            ).scalar_one_or_none()
            if dup is not None:
                raise ValueError("已存在同名数据来源，请更换名称")
            provider.name = name
        if access_method is not None:
            provider.access_method = access_method
        if config is not None:
            provider.config = config
        if enabled is not None:
            provider.enabled = enabled
        if description is not None:
            provider.description = description
        await self.session.flush()
        await self.session.refresh(provider)
        return provider

    async def delete(self, provider: SecuritiesDataProvider) -> None:
        await self.session.delete(provider)
        await self.session.flush()
