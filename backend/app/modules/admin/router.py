"""管理员路由 — 受角色保护的证券行情数据提供方管理。

多提供方管理（取代旧的单 URL 系统配置 system-config 端点）：
- GET    /api/admin/quote-providers：列出全部提供方（含默认 / 当前标记）。
- POST   /api/admin/quote-providers：新增提供方（access_method=https|sdk，config 按接入方式校验必填字段）。
- GET    /api/admin/quote-providers/{id}：读取单个。
- PATCH  /api/admin/quote-providers/{id}：局部更新。
- DELETE /api/admin/quote-providers/{id}：删除。
- POST   /api/admin/quote-providers/{id}/set-default：设为默认（全局至多一个默认）。
- POST   /api/admin/quote-providers/{id}/set-active：设为当前运行时使用（全局至多一个当前；禁用者不可设）。

安全约束：所有端点均依赖 require_admin（查库校验角色），非管理员返回 403。
is_default / is_active 的「全局至多一个」由服务层写入时保证（见 services.quote_provider）。
未来真正的行情客户端调用 services.quote_provider.get_active_provider(db) 即可拿到应使用的源及其连接参数。
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.envelope import EnvelopeRoute
from app.core.security import CurrentUser, require_admin
from app.db.database import get_db
from app.models.enums import QuoteProviderAccessMethod
from app.services.quote_provider import QuoteProviderService


def _check_config(access_method: QuoteProviderAccessMethod, config: dict[str, Any]) -> None:
    """按接入方式校验 config 的必填字段。"""
    if access_method == QuoteProviderAccessMethod.HTTPS:
        if not isinstance(config.get("base_url"), str) or not config.get("base_url"):
            raise ValueError("HTTPS 接入方式必须提供 base_url（字符串）")
    elif access_method == QuoteProviderAccessMethod.SDK:
        if not isinstance(config.get("sdk_name"), str) or not config.get("sdk_name"):
            raise ValueError("SDK 接入方式必须提供 sdk_name（字符串，如 akshare）")


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
        # 同时给出接入方式与 config 时（视为完整重描）才做结构校验；
        # 仅改 config 而不动接入方式时，信任既有接入方式的语义。
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
    created_at: str
    updated_at: str

    model_config = ConfigDict(from_attributes=True)


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


@router_admin.post("/quote-providers", status_code=status.HTTP_201_CREATED)
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
