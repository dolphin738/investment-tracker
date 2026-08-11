"""证券行情数据提供方模型 — 多提供方管理（系统管理页可配置）。

每个提供方描述一个证券行情数据源，含：
- name：展示名称（如「AKShare 官方」）。
- provider_type：提供方类型标识（如 akshare / tushare / sina / custom），用于区分不同厂商。
- access_method：接入方式（HTTPS / SDK），决定 config 的连接参数结构（见 QuoteProviderAccessMethod）。
- config：JSON 连接参数（按接入方式存不同字段；结构由路由层 pydantic 校验）。
- is_default：是否为默认提供方（无明确指定时使用）；全局至多一个 true。
- is_active：当前运行时使用的提供方（运行时切换）；全局至多一个 true。
- enabled：是否启用（禁用后不参与解析、不可设为当前/默认）。
- description：备注。

解析链（见 services.quote_provider.get_active_provider）：当前(is_active) → 默认(is_default) → None。
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
    provider_type: Mapped[str] = mapped_column(String(50), nullable=False)
    access_method: Mapped[str] = mapped_column(String(20), nullable=False)
    config: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
