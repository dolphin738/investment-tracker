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

from sqlalchemy import Boolean, Enum as SA_ENUM, ForeignKey, Integer, JSON, String, Text, false
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, pk_uuid
from app.models.enums import InterfaceDirection, InterfacePurpose, SecurityType


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
    # —— 分类级优先级链（ADR-002 方案 X）——
    priority: Mapped[Optional[int]] = mapped_column(
        Integer, nullable=True, index=True, comment="分类内排序，越小优先级越高"
    )
    consecutive_failures: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0",
        comment="连续无响应计数（DB 原子自增）",
    )
    alerted: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false(),
        comment="连续失败达阈值后的告警去重抢占标志",
    )
    resp_code_field: Mapped[str] = mapped_column(
        String(64), nullable=False, default="code", server_default="code",
        comment="响应中标识证券代码的字段名（接口级）",
    )
    resp_price_field: Mapped[str] = mapped_column(
        String(64), nullable=False, default="price", server_default="price",
        comment="响应中标识价格的字段名（接口级）",
    )
    # —— 证券列表接口（purpose=MASTER_LIST）配置字段（§7 ① / §11）——
    purpose: Mapped[InterfacePurpose] = mapped_column(
        SA_ENUM(
            InterfacePurpose,
            name="InterfacePurpose",
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
        default=InterfacePurpose.QUOTE,
        server_default=InterfacePurpose.QUOTE.value,
        comment="接口用途：价格行情 QUOTE / 证券列表 MASTER_LIST",
    )
    asset_class: Mapped[Optional[SecurityType]] = mapped_column(
        SA_ENUM(SecurityType, name="SecurityType", native_enum=True, create_type=False),
        nullable=True,
        comment="该接口拉取资产类别（复用 SecurityType）；主数据行 type 即=asset_class",
    )
    resp_name_field: Mapped[Optional[str]] = mapped_column(
        String(64), nullable=True, default="name", server_default="name",
        comment="响应中证券名称字段（列表解析用，默认 name）",
    )
    resp_exchange_field: Mapped[Optional[str]] = mapped_column(
        String(64), nullable=True,
        comment="响应中交易所字段（如 exchange/market）；缺失则代码前缀推断",
    )
