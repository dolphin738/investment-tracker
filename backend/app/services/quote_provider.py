"""证券行情数据提供方服务 — 多提供方管理 CRUD。

- list / get / create / update / delete：受 admin 路由保护的 CRUD。
- 全局单一活跃源（is_default / is_active + set_default / set_active /
  get_active_provider）已完全移除（ADR-002 方案 X）：提供方仅保留 `enabled`
  启停开关，运行时选源由 `MarketDataSyncService.fallback_fetch` 按分类级接口
  优先级链解析，不再经由本服务。

名称唯一性（大小写不敏感）由 create/update 显式查重保证。
"""
from __future__ import annotations

from typing import Any, Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.quote_provider import SecuritiesDataProvider

# 可空列集合：这些列允许被显式置 NULL（即「清空」语义）；
# NOT NULL 列遇到显式 None 仍跳过，避免 IntegrityError。
# 由模型可空性自动派生，与 QuoteInterfaceService 修复保持一致。
_NULLABLE_COLUMNS = frozenset(
    c.key for c in SecuritiesDataProvider.__table__.columns if c.nullable
)


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
        **opts: Any,
    ) -> SecuritiesDataProvider:
        """局部更新：仅应用调用方显式提供的字段。

        调用方须传入 Pydantic 的 model_dump(exclude_unset=True) 结果，以便区分
        「客户端显式传 null（=清空）」与「未传该字段（=不改动）」——旧实现把两者
        都当 None 并一律跳过，导致描述清空后无法保存。

        可空列允许被显式置 NULL（清空生效）；非可空列遇显式 None 仍跳过，避免
        IntegrityError。name 重名检查（排除自身）保留。provider_id 不在更新范围内。
        """
        # name 重名检查（排除自身）：仅当本次显式传了 name
        new_name = opts.get("name")
        if new_name is not None:
            dup = (
                await self.session.execute(
                    select(SecuritiesDataProvider).where(
                        func.lower(SecuritiesDataProvider.name) == func.lower(new_name),
                        SecuritiesDataProvider.id != provider.id,
                    )
                )
            ).scalar_one_or_none()
            if dup is not None:
                raise ValueError("已存在同名数据来源，请更换名称")
        for key, value in opts.items():
            # 非 None 直接写入；None 仅在该列可空时写入（即「清空」语义）
            if value is not None or key in _NULLABLE_COLUMNS:
                setattr(provider, key, value)
        await self.session.flush()
        await self.session.refresh(provider)
        return provider

    async def delete(self, provider: SecuritiesDataProvider) -> None:
        await self.session.delete(provider)
        await self.session.flush()
