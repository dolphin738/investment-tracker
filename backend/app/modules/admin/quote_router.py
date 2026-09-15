"""管理员路由 —— 提供方 / 提供方下接口 / 批量同步端点（自 router.py 按职责拆出）。

覆盖原 ``router_admin`` 的**前 13 个**端点，内部书写顺序与原文逐行一致：

- 提供方 CRUD：``GET/POST /quote-providers``、``GET/PATCH/DELETE /quote-providers/{provider_id}``；
- 提供方下接口：``GET/POST /quote-providers/{provider_id}/interfaces``；
- 全量接口扁平列表：``GET /quote-providers/interfaces`` —— **必须早于**
  ``GET /quote-providers/{provider_id}`` 注册（两者段数相同，Starlette 按注册顺序匹配，
  静态路径必须先行）；
- 单接口读取/更新/删除：``/quote-providers/interfaces/{interface_id}``；
- 同分类拖拽调序：``PATCH /quote-interfaces/reorder``；
- 管理面全量刷新：``POST /quote-providers/sync``。

⚠️ 子 Router 必须**自带** ``prefix`` 与 ``route_class``：``include_router`` 不会把父 Router
的 ``route_class`` 施加到子路由（实测 FastAPI 0.141.1），丢了 ``EnvelopeRoute`` 响应信封全变。
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.envelope import EnvelopeRoute
from app.db.database import AsyncSessionLocal, get_db
from app.models import Portfolio
from app.modules.admin.schemas import (
    QuoteInterfaceCreate,
    QuoteInterfaceOut,
    QuoteInterfaceReorder,
    QuoteInterfaceUpdate,
    QuoteProviderCreate,
    QuoteProviderOut,
    QuoteProviderUpdate,
)
from app.services import InterfaceCategoryService, QuoteInterfaceService
from app.services.auth import CurrentUser, require_admin
from app.services.market_data_sync import MarketDataSyncService
from app.services.quote_provider import QuoteProviderService

router_quote = APIRouter(prefix="/api/admin", tags=["admin"], route_class=EnvelopeRoute)


@router_quote.get("/quote-providers")
async def list_quote_providers(
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[QuoteProviderOut]:
    svc = QuoteProviderService(db)
    providers = await svc.list()
    return [QuoteProviderOut.model_validate(p) for p in providers]


@router_quote.post("/quote-providers")
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


@router_quote.get("/quote-providers/interfaces")
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


@router_quote.get("/quote-providers/{provider_id}")
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


@router_quote.get("/quote-providers/{provider_id}/interfaces")
async def list_provider_interfaces(
    provider_id: str,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[QuoteInterfaceOut]:
    svc = QuoteInterfaceService(db)
    items = await svc.list_by_provider(provider_id)
    return [QuoteInterfaceOut.model_validate(i) for i in items]


@router_quote.post("/quote-providers/{provider_id}/interfaces")
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
        response_fields=body.response_fields,
    )
    await db.commit()
    await db.refresh(obj)
    return QuoteInterfaceOut.model_validate(obj)


@router_quote.patch("/quote-providers/{provider_id}")
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
        # 用 exclude_unset 区分「客户端显式传 null（清空）」与「未传字段（不改动）」，
        # 与 QuoteInterfaceUpdate 修复保持一致（修复「可空字段无法清空」缺陷）。
        # mode="json" 会把 access_method 枚举序列化为字符串值，无需手动 .value。
        data = body.model_dump(exclude_unset=True, mode="json")
        provider = await svc.update(provider, **data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await db.commit()
    await db.refresh(provider)
    return QuoteProviderOut.model_validate(provider)


@router_quote.delete("/quote-providers/{provider_id}")
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


@router_quote.post("/quote-providers/sync")
async def admin_sync_all_prices(
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """管理面全量刷新（需 admin）：遍历全部组合同步实时行情并重建快照/净值。

    返回结构化汇总 ``{portfolios, synced, failed, errors}``。
    性能：按组合并发执行（信号量限流 4，独立会话独立事务），替代原单请求内
    串行遍历（P 组合 × 最坏 8s 上游预算 → 分钟级请求易超时）。
    """
    portfolio_rows = (
        await db.execute(select(Portfolio.id))
    ).scalars().all()

    semaphore = asyncio.Semaphore(4)

    async def _sync_one(pid: str) -> dict:
        # 每组合独立会话/事务：互不持锁，单组合失败不影响其余
        async with semaphore:
            async with AsyncSessionLocal() as session:
                result = await MarketDataSyncService(session).sync_portfolio_prices(pid)
                await session.commit()
                return result

    outcomes = await asyncio.gather(
        *(_sync_one(pid) for pid in portfolio_rows), return_exceptions=True
    )
    total_synced = 0
    total_failed = 0
    errors: list[str] = []
    for pid, outcome in zip(portfolio_rows, outcomes):
        if isinstance(outcome, BaseException):
            errors.append(f"{pid}: {outcome}")
        else:
            total_synced += outcome["synced"]
            total_failed += outcome["failed"]
            errors.extend(outcome["errors"])
    return {
        "portfolios": len(portfolio_rows),
        "synced": total_synced,
        "failed": total_failed,
        "errors": errors,
    }


# --------------------------------------------------------------------------- #
# 提供方接口：单接口读取 / 更新 / 删除
# --------------------------------------------------------------------------- #
@router_quote.get("/quote-providers/interfaces/{interface_id}")
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


@router_quote.patch("/quote-providers/interfaces/{interface_id}")
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
        category = await cat_svc.get_or_none(body.category_id)
        if category is None:
            raise HTTPException(status_code=400, detail="接口分类不存在")
    # 用 exclude_unset 区分「客户端显式传 null（=清空）」与「未传该字段（=不改动）」。
    # 旧写法把两者都当 None 传入，服务层一律跳过 → 资产类别取消全选后无法保存（清空失效）。
    opts = body.model_dump(exclude_unset=True)
    # direction 是枚举：落库存原始字符串；显式 null 视为「不改动」（该列 NOT NULL，不可清空）
    if "direction" in opts:
        direction = opts["direction"]
        if direction is None:
            opts.pop("direction")
        else:
            opts["direction"] = getattr(direction, "value", direction)
    obj = await svc.update(obj, **opts)
    await db.commit()
    await db.refresh(obj)
    return QuoteInterfaceOut.model_validate(obj)


@router_quote.delete("/quote-providers/interfaces/{interface_id}")
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


@router_quote.patch("/quote-interfaces/reorder")
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
