"""提供方接口模型 — 证券行情数据提供方下的接口 CRUD。

每个接口属于一个证券行情数据提供方（SecuritiesDataProvider），描述该提供方暴露的一个
可调用的行情接口（如「沪深股票列表」「A股日行情」）。

- provider_id：外键 → securities_data_providers.id，ON DELETE CASCADE（删除提供方级联删接口）。
- category_id：外键 → quote_provider_interface_categories.id，ON DELETE SET NULL（删除分类仅使接口
  变为「未分类」，不影响接口存活）；可空（未分类接口为 NULL）。
- direction：接口方向（in/out），PG 原生枚举 interface_direction；业务当前仅落库（默认 in）。
- params：请求参数模板（JSON）；可空，默认空对象。
- http_method：GET/POST/PUT/DELETE/PATCH 之一（大写），SDK 接口可留空。
- rate_limit：自由文本（如 100/min），不做结构化解析。
"""
from __future__ import annotations

from typing import Any, Optional

from sqlalchemy import Boolean, Enum as SA_ENUM, ForeignKey, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, pk_uuid
from app.models.enums import InterfaceDirection


class QuoteInterface(Base, TimestampMixin):
    __tablename__ = "quote_provider_interfaces"

    id: Mapped[str] = pk_uuid()
    provider_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("securities_data_providers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    category_id: Mapped[Optional[str]] = mapped_column(
        String(36),
        ForeignKey("quote_provider_interface_categories.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    endpoint: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    http_method: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    params: Mapped[Optional[dict[str, Any]]] = mapped_column(
        JSON, nullable=True, default=dict
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    direction: Mapped[str] = mapped_column(
        SA_ENUM(
            InterfaceDirection,
            name="interface_direction",
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
        default=InterfaceDirection.IN.value,
        server_default=InterfaceDirection.IN.value,
    )
    timeout: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    retry_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    rate_limit: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
