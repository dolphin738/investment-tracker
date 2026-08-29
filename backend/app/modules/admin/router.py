"""管理员路由 — 受角色保护的证券行情数据提供方 / 接口 / 接口分类管理。

多提供方管理（取代旧的单 URL 系统配置 system-config 端点）：
- GET    /api/admin/quote-providers：列出全部提供方。
- POST   /api/admin/quote-providers：新增提供方（access_method=https|sdk，config 按接入方式校验必填字段）。
- GET    /api/admin/quote-providers/{id}：读取单个。
- PATCH  /api/admin/quote-providers/{id}：局部更新。
- DELETE /api/admin/quote-providers/{id}：删除（级联删除其下接口）。

提供方接口（QuoteInterface）CRUD：
- GET    /api/admin/quote-providers/{provider_id}/interfaces：列出某提供方全部接口。
- POST   /api/admin/quote-providers/{provider_id}/interfaces：新增接口（provider 不存在 → 404；category_id 不存在 → 400）。
- GET    /api/admin/quote-providers/interfaces：扁平返回全部接口（顶层按分类汇总总览）。
- GET    /api/admin/quote-providers/interfaces/{interface_id}：读取单个。
- PATCH  /api/admin/quote-providers/interfaces/{interface_id}：局部更新。
- DELETE /api/admin/quote-providers/interfaces/{interface_id}：删除。

接口分类（InterfaceCategory）CRUD：
- GET    /api/admin/interface-categories：列出全部分类（按 sort_order 升序）。
- POST   /api/admin/interface-categories：新增分类（label 必填）。
- PATCH  /api/admin/interface-categories/{id}：更新分类。
- DELETE /api/admin/interface-categories/{id}：删除（不影响接口）。

安全约束：所有端点均依赖 require_admin（查库校验角色），非管理员返回 403。
提供方仅保留 enabled 启停开关（全局单一活跃源 is_default/is_active 已移除，见 ADR-002）。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import case, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import paginate
from app.core.envelope import EnvelopeRoute
from app.core.security import CurrentUser, get_current_user, require_admin
from app.db.database import get_db
from app.models import Portfolio, PortfolioSecurity, Security
from app.models.enums import InterfaceDirection, QuoteProviderAccessMethod
from app.serializers import serialize_security_master
from app.services import InterfaceCategoryService, QuoteInterfaceService
from app.services.market_data_sync import MarketDataSyncService
from app.services.notification import NotificationService
from app.services.quote_provider import QuoteProviderService


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
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# --------------------------------------------------------------------------- #
# 路由
# --------------------------------------------------------------------------- #
router_admin = APIRouter(
    prefix="/api/admin", tags=["admin"], route_class=EnvelopeRoute
)


@router_admin.get("/quote-providers")
async def list_quote_providers(
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[QuoteProviderOut]:
    svc = QuoteProviderService(db)
    providers = await svc.list()
    return [QuoteProviderOut.model_validate(p) for p in providers]


@router_admin.post("/quote-providers")
async def create_quote_provider(
    body: QuoteProviderCreate,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> QuoteProviderOut:
    svc = QuoteProviderService(db)
    try:
        provider = await svc.create(
            name=body.name,
            access_method=body.access_method.value,
            config=body.config,
            enabled=body.enabled,
            description=body.description,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await db.commit()
    await db.refresh(provider)
    return QuoteProviderOut.model_validate(provider)


@router_admin.get("/quote-providers/interfaces")
async def list_all_interfaces(
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[QuoteInterfaceOut]:
    """扁平返回全部接口（顶层按分类汇总所有提供方接口总览）。

    注意：必须注册在 `GET /quote-providers/{provider_id}` 之前，否则会被后者按
    路径参数 provider_id='interfaces' 抢匹配。与 `GET /quote-providers/{provider_id}/interfaces`
    段数不同，互不冲突。
    """
    svc = QuoteInterfaceService(db)
    items = await svc.list_all()
    return [QuoteInterfaceOut.model_validate(i) for i in items]


@router_admin.get("/quote-providers/{provider_id}")
async def get_quote_provider(
    provider_id: str,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> QuoteProviderOut:
    svc = QuoteProviderService(db)
    provider = await svc.get(provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="提供方不存在")
    return QuoteProviderOut.model_validate(provider)


@router_admin.get("/quote-providers/{provider_id}/interfaces")
async def list_provider_interfaces(
    provider_id: str,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[QuoteInterfaceOut]:
    svc = QuoteInterfaceService(db)
    items = await svc.list_by_provider(provider_id)
    return [QuoteInterfaceOut.model_validate(i) for i in items]


@router_admin.post("/quote-providers/{provider_id}/interfaces")
async def create_provider_interface(
    provider_id: str,
    body: QuoteInterfaceCreate,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> QuoteInterfaceOut:
    provider_svc = QuoteProviderService(db)
    provider = await provider_svc.get(provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="提供方不存在")
    # 预校验分类存在：category_id 是外键，传入「格式合法但不存在」的 id 必须在
    # 写入前拦截为 400，否则 flush() 触发外键 IntegrityError 会被兜底成 500（见 QA 回归）。
    cat_svc = InterfaceCategoryService(db)
    category = await cat_svc.get_or_none(body.category_id)
    if category is None:
        raise HTTPException(status_code=400, detail="接口分类不存在")
    svc = QuoteInterfaceService(db)
    obj = await svc.create(
        provider_id=provider_id,
        category_id=body.category_id,
        name=body.name,
        endpoint=body.endpoint,
        http_method=body.http_method,
        params=body.params,
        enabled=body.enabled,
        description=body.description,
        direction=body.direction.value,
        timeout=body.timeout,
        retry_count=body.retry_count,
        rate_limit=body.rate_limit,
        asset_class=body.asset_class,
        resp_code_field=body.resp_code_field,
        resp_price_field=body.resp_price_field,
        resp_name_field=body.resp_name_field,
        resp_exchange_field=body.resp_exchange_field,
        response_parse=body.response_parse,
    )
    await db.commit()
    await db.refresh(obj)
    return QuoteInterfaceOut.model_validate(obj)


@router_admin.patch("/quote-providers/{provider_id}")
async def update_quote_provider(
    provider_id: str,
    body: QuoteProviderUpdate,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> QuoteProviderOut:
    svc = QuoteProviderService(db)
    provider = await svc.get(provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="提供方不存在")
    try:
        provider = await svc.update(
            provider,
            name=body.name,
            access_method=body.access_method.value if body.access_method is not None else None,
            config=body.config,
            enabled=body.enabled,
            description=body.description,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await db.commit()
    await db.refresh(provider)
    return QuoteProviderOut.model_validate(provider)


@router_admin.delete("/quote-providers/{provider_id}")
async def delete_quote_provider(
    provider_id: str,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    svc = QuoteProviderService(db)
    provider = await svc.get(provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="提供方不存在")
    await svc.delete(provider)
    await db.commit()
    return {"id": provider_id, "deleted": True}


@router_admin.post("/quote-providers/sync")
async def admin_sync_all_prices(
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """管理面全量刷新（需 admin）：遍历全部组合同步实时行情并重建快照/净值。

    返回结构化汇总 ``{portfolios, synced, failed, errors}``。
    """
    portfolio_rows = (
        await db.execute(select(Portfolio.id))
    ).scalars().all()
    total_synced = 0
    total_failed = 0
    errors: list[str] = []
    for pid in portfolio_rows:
        try:
            result = await MarketDataSyncService(db).sync_portfolio_prices(pid)
            total_synced += result["synced"]
            total_failed += result["failed"]
            errors.extend(result["errors"])
        except Exception as exc:
            errors.append(str(exc))
    await db.commit()
    return {
        "portfolios": len(portfolio_rows),
        "synced": total_synced,
        "failed": total_failed,
        "errors": errors,
    }


# --------------------------------------------------------------------------- #
# 提供方接口：单接口读取 / 更新 / 删除
# --------------------------------------------------------------------------- #
@router_admin.get("/quote-providers/interfaces/{interface_id}")
async def get_interface(
    interface_id: str,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> QuoteInterfaceOut:
    svc = QuoteInterfaceService(db)
    obj = await svc.get(interface_id)
    if obj is None:
        raise HTTPException(status_code=404, detail="接口不存在")
    return QuoteInterfaceOut.model_validate(obj)


@router_admin.patch("/quote-providers/interfaces/{interface_id}")
async def update_interface(
    interface_id: str,
    body: QuoteInterfaceUpdate,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> QuoteInterfaceOut:
    svc = QuoteInterfaceService(db)
    obj = await svc.get(interface_id)
    if obj is None:
        raise HTTPException(status_code=404, detail="接口不存在")
    # 局部更新时若显式传了 category_id（非 None），预校验分类存在；
    # category_id 为 None 表示「置为未分类」，属合法意图，无需校验。
    if body.category_id is not None:
        cat_svc = InterfaceCategoryService(db)
        category = await cat_svc.get(body.category_id)
        if category is None:
            raise HTTPException(status_code=400, detail="接口分类不存在")
    obj = await svc.update(
        obj,
        category_id=body.category_id,
        name=body.name,
        endpoint=body.endpoint,
        http_method=body.http_method,
        params=body.params,
        enabled=body.enabled,
        description=body.description,
        direction=body.direction.value if body.direction is not None else None,
        timeout=body.timeout,
        retry_count=body.retry_count,
        rate_limit=body.rate_limit,
        asset_class=body.asset_class,
        resp_code_field=body.resp_code_field,
        resp_price_field=body.resp_price_field,
        resp_name_field=body.resp_name_field,
        resp_exchange_field=body.resp_exchange_field,
        response_parse=body.response_parse,
    )
    await db.commit()
    await db.refresh(obj)
    return QuoteInterfaceOut.model_validate(obj)


@router_admin.delete("/quote-providers/interfaces/{interface_id}")
async def delete_interface(
    interface_id: str,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    svc = QuoteInterfaceService(db)
    obj = await svc.get(interface_id)
    if obj is None:
        raise HTTPException(status_code=404, detail="接口不存在")
    await svc.delete(obj)
    await db.commit()
    return {"id": interface_id, "deleted": True}


@router_admin.patch("/quote-interfaces/reorder")
async def reorder_quote_interfaces(
    body: QuoteInterfaceReorder,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """同分类内拖拽调序：前端 dnd 产生的完整有序 id 列表 → priority=index。

    跨分类 id 混入 / 不存在 id → 400（由 QuoteInterfaceService.reorder 抛出）。
    """
    svc = QuoteInterfaceService(db)
    await svc.reorder(body.category_id, body.ordered_ids)
    await db.commit()
    return {"ok": True}


# --------------------------------------------------------------------------- #
# 站内信通知（ADR-002 §3 Q2 默认「管理面站内信」）
# --------------------------------------------------------------------------- #
@router_admin.get("/notifications")
async def list_notifications(
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[NotificationOut]:
    """站内信列表（按 created_at 倒序）；前端据 read 字段算未读数。"""
    items = await NotificationService(db).list_all()
    return [NotificationOut.model_validate(n) for n in items]


@router_admin.post("/notifications/{notification_id}/read")
async def mark_notification_read(
    notification_id: str,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> NotificationOut:
    """标记单条通知为已读（不存在 → 404）。"""
    obj = await NotificationService(db).mark_read(notification_id)
    await db.commit()
    return NotificationOut.model_validate(obj)


# --------------------------------------------------------------------------- #
# 接口分类：列表 / 新增 / 更新 / 删除
# --------------------------------------------------------------------------- #
@router_admin.get("/interface-categories")
async def list_interface_categories(
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[InterfaceCategoryOut]:
    svc = InterfaceCategoryService(db)
    items = await svc.list()
    return [InterfaceCategoryOut.model_validate(i) for i in items]


@router_admin.post("/interface-categories")
async def create_interface_category(
    body: InterfaceCategoryCreate,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> InterfaceCategoryOut:
    svc = InterfaceCategoryService(db)
    # 系统分类同名校验统一在 service 层（单一事实来源，覆盖非 HTTP 调用方）
    cat = await svc.create(
        label=body.label, icon=body.icon, sort_order=body.sort_order
    )
    await db.commit()
    await db.refresh(cat)
    return InterfaceCategoryOut.model_validate(cat)


@router_admin.patch("/interface-categories/{category_id}")
async def update_interface_category(
    category_id: str,
    body: InterfaceCategoryUpdate,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> InterfaceCategoryOut:
    svc = InterfaceCategoryService(db)
    cat = await svc.get(category_id)
    if cat is None:
        raise HTTPException(status_code=404, detail="分类不存在")
    cat = await svc.update(
        cat,
        label=body.label,
        icon=body.icon,
        sort_order=body.sort_order,
    )
    await db.commit()
    await db.refresh(cat)
    return InterfaceCategoryOut.model_validate(cat)


@router_admin.delete("/interface-categories/{category_id}")
async def delete_interface_category(
    category_id: str,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    svc = InterfaceCategoryService(db)
    cat = await svc.get(category_id)
    if cat is None:
        raise HTTPException(status_code=404, detail="分类不存在")
    # 系统分类不可删除的校验统一在 service 层
    await svc.delete(cat)
    await db.commit()
    return {"id": category_id, "deleted": True}


# --------------------------------------------------------------------------- #
# 证券主数据（系统级 securities，portfolio_id IS NULL）：列表 / 同步 / 单接口测试
# --------------------------------------------------------------------------- #
class InterfaceTestRequest(BaseModel):
    """单接口测试请求体（§5.2）：params 为经前端编辑后的完整有效参数，覆盖 itf.params。"""

    params: dict[str, Any]
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


def _apply_master_filters(stmt, q, asset_class, exchange):
    """证券主数据列表/删除共用的筛选逻辑（q/asset_class/exchange）。"""
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                Security.code.ilike(like),
                Security.name.ilike(like),
                Security.pinyin_initials.ilike(like),
            )
        )
    if asset_class:
        if asset_class == "UNCATEGORIZED":
            stmt = stmt.where(
                or_(Security.asset_class.is_(None), Security.asset_class == "UNCATEGORIZED")
            )
        else:
            stmt = stmt.where(Security.asset_class == asset_class)
    if exchange:
        ex = exchange.strip().upper()
        if ex in ("SH", "SZ", "BJ", "HK"):
            stmt = stmt.where(Security.exchange == ex)
    return stmt


@router_admin.get("/securities/masters")
async def list_security_masters(
    page: int = Query(1, ge=1),
    pageSize: int = Query(20, ge=1, le=200),
    q: Optional[str] = Query(None, description="匹配 code/name/拼音首字母（ILIKE）"),
    asset_class: Optional[str] = Query(
        None,
        description="按资产类别过滤（SecurityType 值；UNCATEGORIZED=未分类，兼容主数据行 asset_class 为 NULL）",
    ),
    exchange: Optional[str] = Query(
        None,
        description="按交易所过滤（SH/SZ/BJ/HK；主数据行 exchange 可空，传入空字符串不做过滤）",
    ),
    current: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """系统级证券主数据目录表分页浏览；q 匹配 code/name/拼音首字母。

    任意登录用户可读（§10：录入界面证券搜索复用本端点，主数据行是系统级公共字典）；
    写入（sync）与接口测试仍仅限管理员。
    """
    stmt = select(Security)
    stmt = _apply_master_filters(stmt, q, asset_class, exchange)
    # 全部分类视图下，按类别排序使「股票」置顶、「未分类」垫底，
    # 单类别筛选时整列类别一致，退化为 code 稳定排序，不影响筛选结果。
    category_rank = case(
        (Security.asset_class == "STOCK", 0),
        (Security.asset_class == "HK_STOCK", 1),
        (Security.asset_class.is_(None), 9),
        (Security.asset_class == "UNCATEGORIZED", 9),
        else_=3,
    )
    # 交易所排序：同类别内 沪(SH) < 深(SZ) < 京(BJ) < 港(HK) < 其他 < 无
    # 使股票分类下沪市先于深市、深市先于京市（替代原先按 code 字符串排序，
    # 原 'bj' < 'sh' 会让北交所误排沪市之前）。
    exchange_rank = case(
        (Security.exchange == "SH", 0),
        (Security.exchange == "SZ", 1),
        (Security.exchange == "BJ", 2),
        (Security.exchange == "HK", 3),
        (Security.exchange.is_(None), 5),
        else_=4,
    )
    stmt = stmt.order_by(category_rank.asc(), exchange_rank.asc(), Security.code.asc())
    return await paginate(db, stmt, page, pageSize, serialize_security_master)


@router_admin.get("/securities/masters/stats")
async def security_master_stats(
    current: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """系统级证券主数据按资产类别统计条数（公共字典统计，任意登录用户可读）。

    返回 ``{counts: {资产类别: 条数}}``；主数据行 asset_class 为 NULL 时归入
    ``UNCATEGORIZED``（未分类）以便前端与统一中文标签对齐。
    """
    rows = (
        await db.execute(
            select(Security.asset_class, func.count())
            .group_by(Security.asset_class)
        )
    ).all()
    counts: dict[str, int] = {}
    for ac, cnt in rows:
        key = ac.value if ac is not None else "UNCATEGORIZED"
        counts[key] = cnt
    return {"counts": counts}


@router_admin.delete("/securities/masters")
async def delete_security_masters(
    body: SecurityMasterDeleteBody,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """批量/单行删除证券主数据（系统级目录表）。

    删除权限等同 ``POST /securities/sync``（``require_admin``）：非管理员 → 403，未登录 → 401。

    单事务（结尾仅一处 ``await db.commit()``）：先剔除「不存在」与「被组合持仓引用」的 id
    （计入 skipped），仅删除孤儿主数据，绝不波及用户数据——组合持仓/交易/价格/分红经
    ``FK ondelete=CASCADE`` 仅在删除「被引用」行时才级联，而本端点只删 **无任何
    portfolio_securities 引用** 的孤儿，DB 级联对孤儿无可删子行。

    - 默认（``all=False``）：按请求体传入的 ``ids`` 删除（去重后逐个校验）。
    - ``all=True``：删除「当前筛选条件下全部孤儿主数据」（跨所有页），忽略 ``ids``；
      ``q/asset_class/exchange`` 与列表端点一致，用于定位目标集合。该模式下候选 id 全部
      来自数据库，天然存在，``skipped`` 仅含被组合持仓引用的 id。

    返回 ``{deleted, skipped}``；skipped 每项 ``{id, reason}``。
    """
    # all 模式：按当前筛选条件拉取全部匹配 id，忽略 ids
    if body.all:
        match_stmt = _apply_master_filters(
            select(Security.id), body.q, body.asset_class, body.exchange
        )
        matched = (await db.execute(match_stmt)).scalars().all()
        candidate_ids = list(dict.fromkeys(matched))
    else:
        if not body.ids:
            raise HTTPException(status_code=400, detail="ids 不能为空或格式非法")
        candidate_ids = list(dict.fromkeys(body.ids))

    skipped: list[dict[str, str]] = []

    # 1) 存在性校验（all 模式下天然全存在，不会进入 skipped）
    existing = (
        await db.execute(select(Security.id).where(Security.id.in_(candidate_ids)))
    ).scalars().all()
    existing_set = set(existing)
    for i in candidate_ids:
        if i not in existing_set:
            skipped.append({"id": i, "reason": "主数据不存在"})

    # 2) 引用校验：被组合持仓引用的主数据不删，避免级联清除用户数据
    referenced = (
        await db.execute(
            select(func.distinct(PortfolioSecurity.master_id)).where(
                PortfolioSecurity.master_id.in_(existing)
            )
        )
    ).scalars().all()
    referenced_set = set(referenced)
    for i in candidate_ids:
        if i in referenced_set:
            skipped.append(
                {
                    "id": i,
                    "reason": "已被组合持仓引用，删除将级联清除用户数据，已跳过",
                }
            )

    # 3) 仅删孤儿（存在且未被引用）
    deletable = [
        i for i in candidate_ids if i in existing_set and i not in referenced_set
    ]
    if deletable:
        await db.execute(delete(Security).where(Security.id.in_(deletable)))

    await db.commit()
    return {"deleted": len(deletable), "skipped": skipped}


@router_admin.post("/securities/sync")
async def admin_sync_security_masters(
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """手动触发配置驱动的证券主数据全量同步（遍历全部 MASTER_LIST 接口的资产类别）。"""
    result = await MarketDataSyncService(db).sync_all_security_masters()
    await db.commit()
    return result


@router_admin.post("/quote-interfaces/{interface_id}/test")
async def test_quote_interface(
    interface_id: str,
    body: InterfaceTestRequest,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """单接口测试：用调用方传入的 params 调用，原样回传 raw+parsed（不计入 consecutive_failures）。"""
    result = await MarketDataSyncService(db).test_single_interface(
        interface_id, body.params, body.codes
    )
    return result
