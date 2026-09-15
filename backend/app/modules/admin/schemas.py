"""管理员路由 —— 内联 Pydantic schema 与接入方式配置校验（自 router.py 按职责拆出）。

本模块只承载**请求/响应模型**与纯校验 ``_check_config``，不含任何端点；
由 ``quote_router`` / ``category_router`` / ``master_router`` 及门面 ``router`` 复用：

- 提供方：``QuoteProviderCreate`` / ``QuoteProviderUpdate`` / ``QuoteProviderOut``；
- 提供方接口：``QuoteInterfaceCreate`` / ``QuoteInterfaceUpdate`` / ``QuoteInterfaceOut``
  / ``QuoteInterfaceReorder``；
- 站内信：``NotificationOut``；
- 接口分类：``InterfaceCategoryCreate`` / ``InterfaceCategoryUpdate`` / ``InterfaceCategoryOut``；
- 主数据与试调：``InterfaceTestRequest`` / ``InterfacePreviewRequest`` / ``SecurityMasterDeleteBody``。

门面 ``app.modules.admin.router`` 会 re-export 全部模型，既有
``from app.modules.admin.router import QuoteInterfaceUpdate`` 等导入点零改动。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.enums import InterfaceDirection, QuoteProviderAccessMethod


def _check_config(access_method: QuoteProviderAccessMethod, config: dict[str, Any]) -> None:
    """按接入方式校验 config 的必填字段。"""
    if access_method == QuoteProviderAccessMethod.HTTPS:
        base_url = config.get("base_url")
        if not isinstance(base_url, str) or not base_url:
            raise ValueError("HTTPS 接入方式必须提供 base_url（字符串）")
        # SSRF 防护：base_url 仅允许 http/https（provider 可能位于内网，放开私网）
        from app.core.url_guard import assert_safe_url

        assert_safe_url(base_url, allow_private=True)
    elif access_method == QuoteProviderAccessMethod.SDK:
        if not isinstance(config.get("sdk_name"), str) or not config.get("sdk_name"):
            raise ValueError("SDK 接入方式必须提供 sdk_name（字符串，如 akshare）")


# --------------------------------------------------------------------------- #
# 提供方（SecuritiesDataProvider）内联 schema
# --------------------------------------------------------------------------- #
class QuoteProviderCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    access_method: QuoteProviderAccessMethod
    config: dict[str, Any]
    enabled: bool = True
    description: Optional[str] = None

    @model_validator(mode="after")
    def _validate(self) -> "QuoteProviderCreate":
        _check_config(self.access_method, self.config)
        return self


class QuoteProviderUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    access_method: Optional[QuoteProviderAccessMethod] = None
    config: Optional[dict[str, Any]] = None
    enabled: Optional[bool] = None
    description: Optional[str] = None

    @model_validator(mode="after")
    def _validate(self) -> "QuoteProviderUpdate":
        if self.access_method is not None and self.config is not None:
            _check_config(self.access_method, self.config)
        return self


class QuoteProviderOut(BaseModel):
    id: str
    name: str
    access_method: str
    config: dict[str, Any]
    enabled: bool
    description: Optional[str]
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# --------------------------------------------------------------------------- #
# 提供方接口（QuoteInterface）内联 schema
# --------------------------------------------------------------------------- #
class QuoteInterfaceCreate(BaseModel):
    category_id: str = Field(
        ..., description="接口分类 id（外键→quote_provider_interface_categories.id）"
    )
    name: str = Field(..., min_length=1, max_length=255)
    endpoint: Optional[str] = Field(None, max_length=512)
    http_method: Optional[Literal["GET", "POST", "PUT", "DELETE", "PATCH"]] = None
    params: Optional[dict[str, Any]] = None
    enabled: bool = True
    description: Optional[str] = None
    direction: InterfaceDirection = InterfaceDirection.IN
    timeout: Optional[int] = None
    retry_count: Optional[int] = None
    rate_limit: Optional[str] = Field(None, max_length=64)
    # —— 资产类别 / 列表解析字段（§7 ① / §11，MASTER_LIST 配置能力）——
    # asset_class 多选：仅用于「同步选源批次归属」，行级归类由代码推断决定
    asset_class: Optional[list[str]] = None
    resp_code_field: Optional[str] = Field(None, max_length=64)
    resp_price_field: Optional[str] = Field(None, max_length=64)
    resp_name_field: Optional[str] = Field(None, max_length=64)
    resp_exchange_field: Optional[str] = Field(None, max_length=64)
    # —— 响应字段映射（P1 Expand 新增，与旧 4 列并行；见 plan-interface-response-fields）——
    # 元素：{key, label, slot, source, type, required, scale, unit, date_format}
    response_fields: Optional[list[dict[str, Any]]] = None
    # —— 响应解析协议（覆盖非 JSON 文本源，如腾讯财经 ~ 分隔）——
    response_parse: Optional[dict[str, Any]] = None


class QuoteInterfaceUpdate(BaseModel):
    category_id: Optional[str] = Field(
        None, description="接口分类 id，可空表示未分类（外键→quote_provider_interface_categories.id）"
    )
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    endpoint: Optional[str] = Field(None, max_length=512)
    http_method: Optional[Literal["GET", "POST", "PUT", "DELETE", "PATCH"]] = None
    params: Optional[dict[str, Any]] = None
    enabled: Optional[bool] = None
    description: Optional[str] = None
    direction: Optional[InterfaceDirection] = None
    timeout: Optional[int] = None
    retry_count: Optional[int] = None
    rate_limit: Optional[str] = Field(None, max_length=64)
    asset_class: Optional[list[str]] = None
    resp_code_field: Optional[str] = Field(None, max_length=64)
    resp_price_field: Optional[str] = Field(None, max_length=64)
    resp_name_field: Optional[str] = Field(None, max_length=64)
    resp_exchange_field: Optional[str] = Field(None, max_length=64)
    response_fields: Optional[list[dict[str, Any]]] = None
    response_parse: Optional[dict[str, Any]] = None


class QuoteInterfaceOut(BaseModel):
    id: str
    provider_id: str
    category_id: Optional[str] = None
    name: str
    endpoint: Optional[str]
    http_method: Optional[str]
    params: Optional[dict[str, Any]]
    enabled: bool
    description: Optional[str]
    direction: str
    timeout: Optional[int]
    retry_count: Optional[int]
    rate_limit: Optional[str]
    priority: Optional[int] = None
    asset_class: Optional[list[str]] = None
    resp_code_field: str
    resp_price_field: str
    resp_name_field: Optional[str] = None
    resp_exchange_field: Optional[str] = None
    response_fields: Optional[list[dict[str, Any]]] = None
    response_parse: Optional[dict[str, Any]] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class QuoteInterfaceReorder(BaseModel):
    """同分类内拖拽调序请求体（前端 dnd 产生的完整有序 id 列表）。"""

    category_id: str = Field(..., description="接口分类 id")
    ordered_ids: list[str] = Field(
        ..., description="该分类下完整接口 id 列表，顺序即新优先级"
    )


class NotificationOut(BaseModel):
    id: str
    level: str
    title: str
    message: str
    related_type: Optional[str]
    related_id: Optional[str]
    read: bool
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


# --------------------------------------------------------------------------- #
# 接口分类（InterfaceCategory）内联 schema
# --------------------------------------------------------------------------- #
class InterfaceCategoryCreate(BaseModel):
    label: str = Field(..., min_length=1, max_length=128)
    icon: Optional[str] = Field(None, max_length=64)
    sort_order: int = 0


class InterfaceCategoryUpdate(BaseModel):
    label: Optional[str] = Field(None, min_length=1, max_length=128)
    icon: Optional[str] = Field(None, max_length=64)
    sort_order: Optional[int] = None


class InterfaceCategoryOut(BaseModel):
    id: str
    label: str
    icon: Optional[str]
    sort_order: int
    # 系统内置分类（固定 2 类：证券列表 / 证券行情）：前端据此隐藏删除入口
    system: bool = False
    # 该分类下已配置的接口数，前端据此禁用删除（模型上无此属性，由列表端点填充）
    interface_count: int = 0
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class InterfaceTestRequest(BaseModel):
    """单接口测试请求体（§5.2）：params 为经前端编辑后的完整有效参数，覆盖 itf.params。"""

    params: dict[str, Any]
    codes: Optional[list[str]] = None


class InterfacePreviewRequest(BaseModel):
    """新增态实调预览请求体：不依赖已存接口，按提供方接入方式实调一次。

    - SDK：endpoint 为 akshare 顶层函数名（如 stock_zh_a_spot），params 透传
      （空则按签名默认值调用）；下方 HTTPS 专用字段被忽略。
    - HTTPS：endpoint 为相对 base_url 的路径（以 ``=`` 结尾时为内联代码形态，
      如腾讯财经 ``q=``）；response_parse / http_method / codes 取弹窗当前值。
    """

    endpoint: str = Field(
        min_length=1, description="SDK 顶层函数名或 HTTPS 相对路径（如 stock_zh_a_spot / q=）"
    )
    provider_id: str
    params: dict[str, Any] = {}
    # —— HTTPS 专用（SDK 忽略）——
    response_parse: dict[str, Any] = {}
    http_method: Optional[str] = None
    codes: Optional[list[str]] = None


class SecurityMasterDeleteBody(BaseModel):
    """批量/单行删除证券主数据请求体。
    - ids：待删除主数据 id 列表（all=False 时必填，可含重复，后端去重）。
    - all=True：删除「当前筛选条件下全部孤儿主数据」（跨所有页），忽略 ids；
      q/asset_class/exchange 与列表端点一致，用于定位目标集合。
    """
    ids: list[str] = []
    all: bool = False
    q: Optional[str] = None
    asset_class: Optional[str] = None
    exchange: Optional[str] = None
