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

from sqlalchemy import ARRAY, Boolean, Enum as SA_ENUM, ForeignKey, Integer, JSON, String, Text, false
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
    # —— 证券列表接口（归属「证券列表」分类）配置字段（§7 ① / §11）——
    # asset_class 改为多选（存 SecurityType 值字符串数组）：仅用于「同步选源批次归属」——
    # 决定该接口参与哪些 asset_class 批次的调用；行级 asset_class 由代码推断决定，不由此字段强制。
    asset_class: Mapped[Optional[list[str]]] = mapped_column(
        ARRAY(String(20)),
        nullable=True,
        comment="可服务的资产类别（多选，存 SecurityType 值字符串）；仅用于同步选源批次归属",
    )
    resp_name_field: Mapped[Optional[str]] = mapped_column(
        String(64), nullable=True, default="name", server_default="name",
        comment="响应中证券名称字段（列表解析用，默认 name）",
    )
    resp_exchange_field: Mapped[Optional[str]] = mapped_column(
        String(64), nullable=True,
        comment="响应中交易所字段（如 exchange/market）；缺失则代码前缀推断",
    )
    # —— 响应解析协议（接口级，覆盖非 JSON 文本源，如腾讯财经 ~ 分隔）——
    # 结构：{format, encoding, sep, line_regex, code_param, code_prefix}
    # - format: json（默认，走 resp.json()）/ text_split（gbk 文本 + 分隔符）
    # - encoding: 响应解码编码，默认 utf-8（腾讯财经需 gbk）
    # - sep: 文本分隔符（text_split 时），默认 "~"
    # - line_regex: 文本行提取正则（2 组：group1=带前缀代码如 sz000001，group2=内容）
    # - code_param: 代码查询参数名（默认 code；腾讯财经为 q 且 endpoint 以 = 结尾时内联）
    # - code_prefix: 发送代码时自动补交易所前缀；仅 "auto" 生效，位数感知：
    #   5位纯数字→补 hk（港股，如 00700→hk00700）；6位纯数字→按首位推断 sh/sz/bj
    #   裸拼（A股/场内基金，腾讯/新浪风格）；已带前缀或非数字原样，绝不重复加。空=原样。
    response_parse: Mapped[Optional[dict[str, Any]]] = mapped_column(
        JSON, nullable=True, default=dict,
        comment="响应解析协议：{format, encoding, sep, line_regex, code_param, code_prefix}",
    )
