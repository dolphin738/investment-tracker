"""管理员路由 — 受角色保护的证券行情数据提供方 / 接口 / 接口分类管理。

多提供方管理（取代旧的单 URL 系统配置 system-config 端点）：
- GET    /api/admin/quote-providers：列出全部提供方（含默认 / 当前标记）。
- POST   /api/admin/quote-providers：新增提供方（access_method=https|sdk，config 按接入方式校验必填字段）。
- GET    /api/admin/quote-providers/{id}：读取单个。
- PATCH  /api/admin/quote-providers/{id}：局部更新。
- DELETE /api/admin/quote-providers/{id}：删除（级联删除其下接口）。
- POST   /api/admin/quote-providers/{id}/set-default：设为默认（全局至多一个默认）。
- POST   /api/admin/quote-providers/{id}/set-active：设为当前运行时使用（全局至多一个当前；禁用者不可设）。

提供方接口（QuoteInterface）CRUD：
- GET    /api/admin/quote-providers/{provider_id}/interfaces：列出某提供方全部接口。
- POST   /api/admin/quote-providers/{provider_id}/interfaces：新增接口（provider 不存在 → 404）。
- GET    /api/admin/quote-providers/interfaces：扁平返回全部接口（顶层按分类汇总总览）。
- GET    /api/admin/quote-providers/interfaces/{interface_id}：读取单个。
- PATCH  /api/admin/quote-providers/interfaces/{interface_id}：局部更新。
- DELETE /api/admin/quote-providers/interfaces/{interface_id}：删除。

接口分类（InterfaceCategory）CRUD：
- GET    /api/admin/interface-categories：列出全部分类（按 sort_order 升序）。
- POST   /api/admin/interface-categories：新增分类（key 唯一，冲突 → 409）。
- PATCH  /api/admin/interface-categories/{id}：更新分类。
- DELETE /api/admin/interface-categories/{id}：删除（不影响接口）。

安全约束：所有端点均依赖 require_admin（查库校验角色），非管理员返回 403。
is_default / is_active 的「全局至多一个」由服务层写入时保证（见 services.quote_provider）。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.envelope import EnvelopeRoute
from app.core.security import CurrentUser, require_admin
from app.db.database import get_db
from app.models.enums import InterfaceDirection, QuoteProviderAccessMethod
from app.services import InterfaceCategoryService, QuoteInterfaceService
from app.services.quote_provider import QuoteProviderService


def _check_config(access_method: QuoteProviderAccessMethod, config: dict[str, Any]) -> None:
    """按接入方式校验 config 的必填字段。"""
    if access_method == QuoteProviderAccessMethod.HTTPS:
        if not isinstance(config.get("base_url"), str) or not config.get("base_url"):
            raise ValueError("HTTPS 接入方式必须提供 base_url（字符串）")
    elif access_method == QuoteProviderAccessMethod.SDK:
        if not isinstance(config.get("sdk_name"), str) or not config.get("sdk_name"):
            raise ValueError("SDK 接入方式必须提供 sdk_name（字符串，如 akshare）")


# --------------------------------------------------------------------------- #
# 提供方（SecuritiesDataProvider）内联 schema
# --------------------------------------------------------------------------- #
class QuoteProviderCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    provider_type: str = Field(..., min_length=1, max_length=50)
    access_method: QuoteProviderAccessMethod
    config: dict[str, Any]
    enabled: bool = True
    description: Optional[str] = None
    is_default: bool = False
    is_active: bool = False

    @model_validator(mode="after")
    def _validate(self) -> "QuoteProviderCreate":
        _check_config(self.access_method, self.config)
        return self


class QuoteProviderUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    provider_type: Optional[str] = Field(None, min_length=1, max_length=50)
    access_method: Optional[QuoteProviderAccessMethod] = None
    config: Optional[dict[str, Any]] = None
    enabled: Optional[bool] = None
    description: Optional[str] = None
    is_default: Optional[bool] = None
    is_active: Optional[bool] = None

    @model_validator(mode="after")
    def _validate(self) -> "QuoteProviderUpdate":
        if self.access_method is not None and self.config is not None:
            _check_config(self.access_method, self.config)
        return self


class QuoteProviderOut(BaseModel):
    id: str
    name: str
    provider_type: str
    access_method: str
    config: dict[str, Any]
    is_default: bool
    is_active: bool
    enabled: bool
    description: Optional[str]
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# --------------------------------------------------------------------------- #
# 提供方接口（QuoteInterface）内联 schema
# --------------------------------------------------------------------------- #
class QuoteInterfaceCreate(BaseModel):
    interface_type: str = Field(..., min_length=1, max_length=64)
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
    interface_type: Optional[str] = Field(None, min_length=1, max_length=64)
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
    interface_type: str
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
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# --------------------------------------------------------------------------- #
# 接口分类（InterfaceCategory）内联 schema
# --------------------------------------------------------------------------- #
class InterfaceCategoryCreate(BaseModel):
    key: str = Field(..., min_length=1, max_length=64)
    label: str = Field(..., min_length=1, max_length=128)
    icon: Optional[str] = Field(None, max_length=64)
    sort_order: int = 0


class InterfaceCategoryUpdate(BaseModel):
    key: Optional[str] = Field(None, min_length=1, max_length=64)
    label: Optional[str] = Field(None, min_length=1, max_length=128)
    icon: Optional[str] = Field(None, max_length=64)
    sort_order: Optional[int] = None


class InterfaceCategoryOut(BaseModel):
    id: str
    key: str
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
    provider = await svc.create(
        name=body.name,
        provider_type=body.provider_type,
        access_method=body.access_method.value,
        config=body.config,
        enabled=body.enabled,
        description=body.description,
        is_default=body.is_default,
        is_active=body.is_active,
    )
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
    svc = QuoteInterfaceService(db)
    obj = await svc.create(
        provider_id=provider_id,
        interface_type=body.interface_type,
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
    provider = await svc.update(
        provider,
        name=body.name,
        provider_type=body.provider_type,
        access_method=body.access_method.value if body.access_method is not None else None,
        config=body.config,
        enabled=body.enabled,
        description=body.description,
        is_default=body.is_default,
        is_active=body.is_active,
    )
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


@router_admin.post("/quote-providers/{provider_id}/set-default")
async def set_default_quote_provider(
    provider_id: str,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> QuoteProviderOut:
    svc = QuoteProviderService(db)
    provider = await svc.get(provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="提供方不存在")
    provider = await svc.set_default(provider)
    await db.commit()
    await db.refresh(provider)
    return QuoteProviderOut.model_validate(provider)


@router_admin.post("/quote-providers/{provider_id}/set-active")
async def set_active_quote_provider(
    provider_id: str,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> QuoteProviderOut:
    svc = QuoteProviderService(db)
    provider = await svc.get(provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="提供方不存在")
    try:
        provider = await svc.set_active(provider)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await db.commit()
    await db.refresh(provider)
    return QuoteProviderOut.model_validate(provider)


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
    obj = await svc.update(
        obj,
        interface_type=body.interface_type,
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
        key=body.key, label=body.label, icon=body.icon, sort_order=body.sort_order
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
        key=body.key,
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
