"""证券行情数据提供方服务 — 多提供方管理 + 运行时解析。

- list / get / create / update / delete：受 admin 路由保护的 CRUD。
- set_default(id)：将该提供方设为默认，并取消其它提供方的默认标记（is_default 互斥）。
- set_active(id)：将该提供方设为当前运行时提供方（运行时切换），并取消其它提供方的当前标记
  （is_active 互斥）；仅 enabled 的提供方可被设为当前。
- get_active_provider(db)：消费方解析入口，返回「当前」→「默认」→ None 的回退链。
  未来真正的行情客户端直接调用它即可拿到该用哪个源及其连接参数。

is_default / is_active 的「全局至多一个」由本服务在写入时保证（先取消其它再置位），
无需数据库唯一约束，避免部分唯一索引的可移植性问题。
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import select
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
        provider_type: str,
        access_method: str,
        config: dict,
        enabled: bool = True,
        description: Optional[str] = None,
        is_default: bool = False,
        is_active: bool = False,
    ) -> SecuritiesDataProvider:
        provider = SecuritiesDataProvider(
            name=name,
            provider_type=provider_type,
            access_method=access_method,
            config=config,
            enabled=enabled,
            description=description,
            is_default=is_default,
            is_active=is_active,
        )
        self.session.add(provider)
        await self.session.flush()
        # 互斥标记：若要求默认/当前，先取消其它提供方的同名标记
        if is_default:
            await self._clear_flag("is_default", except_id=provider.id)
        if is_active:
            await self._clear_flag("is_active", except_id=provider.id)
        await self.session.refresh(provider)
        return provider

    async def update(
        self,
        provider: SecuritiesDataProvider,
        *,
        name: Optional[str] = None,
        provider_type: Optional[str] = None,
        access_method: Optional[str] = None,
        config: Optional[dict] = None,
        enabled: Optional[bool] = None,
        description: Optional[str] = None,
        is_default: Optional[bool] = None,
        is_active: Optional[bool] = None,
    ) -> SecuritiesDataProvider:
        if name is not None:
            provider.name = name
        if provider_type is not None:
            provider.provider_type = provider_type
        if access_method is not None:
            provider.access_method = access_method
        if config is not None:
            provider.config = config
        if enabled is not None:
            provider.enabled = enabled
        if description is not None:
            provider.description = description
        if is_default is not None:
            provider.is_default = is_default
        if is_active is not None:
            provider.is_active = is_active

        if is_default:
            await self._clear_flag("is_default", except_id=provider.id)
        if is_active:
            await self._clear_flag("is_active", except_id=provider.id)
        await self.session.flush()
        await self.session.refresh(provider)
        return provider

    async def delete(self, provider: SecuritiesDataProvider) -> None:
        await self.session.delete(provider)
        await self.session.flush()

    async def set_default(self, provider: SecuritiesDataProvider) -> SecuritiesDataProvider:
        provider.is_default = True
        await self._clear_flag("is_default", except_id=provider.id)
        await self.session.flush()
        await self.session.refresh(provider)
        return provider

    async def set_active(self, provider: SecuritiesDataProvider) -> SecuritiesDataProvider:
        if not provider.enabled:
            raise ValueError("禁用的提供方不能设为当前使用")
        provider.is_active = True
        await self._clear_flag("is_active", except_id=provider.id)
        await self.session.flush()
        await self.session.refresh(provider)
        return provider

    async def _clear_flag(self, flag: str, *, except_id: str) -> None:
        """取消其它所有提供方的指定布尔标记（保证全局至多一个 true）。"""
        rows = (
            await self.session.execute(
                select(SecuritiesDataProvider).where(
                    SecuritiesDataProvider.id != except_id
                )
            )
        ).scalars().all()
        for row in rows:
            if getattr(row, flag):
                setattr(row, flag, False)
        await self.session.flush()


async def get_active_provider(db: AsyncSession) -> Optional[SecuritiesDataProvider]:
    """解析当前应使用的提供方：当前(is_active) → 默认(is_default) → None。

    供未来真正的行情客户端调用，直接拿到「该用哪个源 + 它的连接参数」。
    """
    active = (
        await db.execute(
            select(SecuritiesDataProvider).where(
                SecuritiesDataProvider.is_active == True  # noqa: E712
            )
        )
    ).scalar_one_or_none()
    if active is not None:
        return active
    default = (
        await db.execute(
            select(SecuritiesDataProvider).where(
                SecuritiesDataProvider.is_default == True  # noqa: E712
            )
        )
    ).scalar_one_or_none()
    return default
