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

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.envelope import EnvelopeRoute
from app.core.security import CurrentUser, require_admin
from app.db.database import get_db
from app.models import Portfolio
from app.models.enums import InterfaceDirection, QuoteProviderAccessMethod
from app.models.notification import Notification
from app.services import InterfaceCategoryService, QuoteInterfaceService
from app.services.market_data_sync import MarketDataSyncService
from app.services.notification import NotificationService
from app.services.quote_provider import QuoteProviderService


def _check_config(access_method: QuoteProviderAccessMethod, config: dict[str, Any]) -> None:
    """按接入方式校验 config 的必填字段。"""
    if access_method == QuoteProviderAccessMethod.HTTPS:
        if not isinstance(config.get("base_url"), str) or not config.get("base_url"):
            raise ValueError("HTTPS 接入方式必须提供 base_url（字符串）")
    elif access_method == QuoteProviderAccessMethod.SDK:
        if not isinstance(config.get("sdk_name"), str) or not config.get("sdk_name"):
            raise ValueError("SDK 接入方式必须提供 sdk_name（字符串，如 akshare）")


# 接口分类 id 必须是合法 UUID（外键引用 quote_provider_interface_categories.id）
UUID_PATTERN: str = (
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


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
        ..., pattern=UUID_PATTERN, description="接口分类 id（UUID，外键→interface_categories.id）"
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


class QuoteInterfaceUpdate(BaseModel):
    category_id: Optional[str] = Field(
        None, pattern=UUID_PATTERN, description="接口分类 id（UUID），可空表示未分类"
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
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class QuoteInterfaceReorder(BaseModel):
    """同分类内拖拽调序请求体（前端 dnd 产生的完整有序 id 列表）。"""

    category_id: str = Field(..., description="接口分类 id（UUID）")
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
    # 预校验分类存在：category_id 是外键，传入「格式合法但不存在」的 uuid 必须在
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
    await svc.delete(cat)
    await db.commit()
    return {"id": category_id, "deleted": True}
