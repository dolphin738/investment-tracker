"""证券行情数据提供方模型 — 多提供方管理（系统管理页可配置）。

每个提供方描述一个证券行情数据源，含：
- name：展示名称（如「AKShare 官方」）。
- access_method：接入方式（HTTPS / SDK），决定 config 的连接参数结构（见 QuoteProviderAccessMethod）。
- config：JSON 连接参数（按接入方式存不同字段；结构由路由层 pydantic 校验）。
- enabled：是否启用（唯一开关；禁用后不参与解析）。

全局单一活跃源（is_default / is_active）已完全移除（ADR-002 方案 X）：提供方仅保留
`enabled` 启停开关，运行时选源改为按分类级接口优先级链（见 MarketDataSyncService.fallback_fetch）。
"""
from __future__ import annotations

from typing import Any, Optional

from sqlalchemy import Boolean, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, pk_uuid


class SecuritiesDataProvider(Base, TimestampMixin):
    __tablename__ = "securities_data_providers"

    id: Mapped[str] = pk_uuid()
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    access_method: Mapped[str] = mapped_column(String(20), nullable=False)
    config: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
