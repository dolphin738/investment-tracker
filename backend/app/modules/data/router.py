"""数据实体路由（CRUD + 写操作级联重算）。

覆盖 docs/ARCHITECTURE.md §4.2.3~§4.2.8：cashflows / securities / security-trades /
security-prices / cash-balances / snapshots。所有写操作经 RecalculationService 统一
入口触发区间重建或级联（§7.3 / §8 / REG-06）。

组合归属隔离由 get_portfolio 保证；证券标的级联删除由 FK ondelete=CASCADE 保证。
"""
from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.envelope import EnvelopeRoute
from app.db.database import get_db
from app.models.enums import CashFlowType, SnapshotSource
from app.common import get_portfolio, paginate
from app.serializers import (
    serialize_cashbalance,
    serialize_cashflow,
    serialize_price,
    serialize_security,
    serialize_snapshot,
    serialize_trade,
)
from app.schemas import (
    CashBalanceCreateReq,
    CashBalancePatchReq,
    CashflowCreateReq,
    CashflowPatchReq,
    PriceCreateReq,
    PricePatchReq,
    SecurityCreateReq,
    SecurityPatchReq,
    SnapshotCreateReq,
    SnapshotPatchReq,
    TradeCreateReq,
    TradePatchReq,
)
from app.schemas_resp import (
    CashBalanceOut,
    CashflowOut,
    Paginated,
    PriceOut,
    SecurityOut,
    SnapshotOut,
    TradeOut,
)
from app.services.cashbalance import CashBalanceService
from app.services.cashflow import CashflowService
from app.services.price import PriceService
from app.services.security import SecurityService
from app.services.snapshot import SnapshotService
from app.services.trade import TradeService


# ═══════════════════════════════════════════════════════════════════════════
# 出入金 §4.2.3
# ═══════════════════════════════════════════════════════════════════════════
router_cashflows = APIRouter(
    prefix="/api/portfolios", tags=["cashflows"], route_class=EnvelopeRoute
)


@router_cashflows.get("/{portfolio_id}/cashflows", response_model=Paginated[CashflowOut])
async def list_cashflows(
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    startDate: Optional[date] = None,
    endDate: Optional[date] = None,
    types: Optional[str] = Query(
        None, description="逗号分隔类型过滤，如 BUY 或 BUY,SELL；非法值忽略"
    ),
    page: int = 1,
    pageSize: int = 20,
):
    # 仅保留白名单内的类型（BUY/SELL），非法片段忽略，避免注入/误过滤
    type_filter: list[CashFlowType] | None = None
    if types:
        type_filter = [CashFlowType(t) for t in types.split(",") if t in ("BUY", "SELL")]
    stmt = await CashflowService(db).list_stmt(p.id, startDate, endDate, types=type_filter)
    return await paginate(db, stmt, page, pageSize, serialize_cashflow)


@router_cashflows.get("/{portfolio_id}/cashflows/{cf_id}", response_model=CashflowOut)
async def get_cashflow(
    p=Depends(get_portfolio), db: AsyncSession = Depends(get_db), cf_id: str = ""
):
    cf = await CashflowService(db).get(p.id, cf_id)
    return serialize_cashflow(cf)


@router_cashflows.post("/{portfolio_id}/cashflows", response_model=CashflowOut)
async def create_cashflow(
    req: CashflowCreateReq, p=Depends(get_portfolio), db: AsyncSession = Depends(get_db)
):
    cf, rec = await CashflowService(db).create(p.id, req)
    result = serialize_cashflow(cf)
    # D3：完整对齐 app/ 的 recalculation 反馈字段
    result["recalculation"] = {
        "fromDate": rec.from_date,
        "affectedDays": rec.affected_days,
        "skippedManualDays": rec.skipped_manual_days,
    }
    return result


@router_cashflows.patch("/{portfolio_id}/cashflows/{cf_id}", response_model=CashflowOut)
async def patch_cashflow(
    req: CashflowPatchReq,
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    cf_id: str = "",
):
    cf, rec = await CashflowService(db).patch(p.id, cf_id, req)
    result = serialize_cashflow(cf)
    result["recalculation"] = {
        "fromDate": rec.from_date,
        "affectedDays": rec.affected_days,
        "skippedManualDays": rec.skipped_manual_days,
    }
    return result


@router_cashflows.delete("/{portfolio_id}/cashflows/{cf_id}")
async def delete_cashflow(
    p=Depends(get_portfolio), db: AsyncSession = Depends(get_db), cf_id: str = ""
):
    rec = await CashflowService(db).delete(p.id, cf_id)
    # D3：删除也返回 recalculation 反馈（对齐 app/ remove 响应）
    return {
        "recalculation": {
            "fromDate": rec.from_date,
            "affectedDays": rec.affected_days,
            "skippedManualDays": rec.skipped_manual_days,
        }
    }


# ═══════════════════════════════════════════════════════════════════════════
# 标的 §4.2.5
# ═══════════════════════════════════════════════════════════════════════════
router_securities = APIRouter(
    prefix="/api/portfolios", tags=["securities"], route_class=EnvelopeRoute
)


@router_securities.get("/{portfolio_id}/securities", response_model=Paginated[SecurityOut])
async def list_securities(
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    page: int = 1,
    pageSize: int = 20,
):
    stmt = await SecurityService(db).list_stmt(p.id)
    return await paginate(db, stmt, page, pageSize, serialize_security)


@router_securities.get("/{portfolio_id}/securities/{sec_id}", response_model=SecurityOut)
async def get_security(
    p=Depends(get_portfolio), db: AsyncSession = Depends(get_db), sec_id: str = ""
):
    sec = await SecurityService(db).get(p.id, sec_id)
    return serialize_security(sec)


@router_securities.post("/{portfolio_id}/securities", response_model=SecurityOut)
async def create_security(
    req: SecurityCreateReq, p=Depends(get_portfolio), db: AsyncSession = Depends(get_db)
):
    sec = await SecurityService(db).create(p.id, req)
    return serialize_security(sec)


@router_securities.patch("/{portfolio_id}/securities/{sec_id}", response_model=SecurityOut)
async def patch_security(
    req: SecurityPatchReq,
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    sec_id: str = "",
):
    sec = await SecurityService(db).patch(p.id, sec_id, req)
    return serialize_security(sec)


@router_securities.delete("/{portfolio_id}/securities/{sec_id}")
async def delete_security(
    p=Depends(get_portfolio), db: AsyncSession = Depends(get_db), sec_id: str = ""
):
    rec = await SecurityService(db).delete(p.id, sec_id)
    # 删除标的后若有成交日则重算并反馈；无成交日返回 null（保持原契约）
    if rec is None:
        return None
    return {
        "recalculation": {
            "fromDate": rec.from_date,
            "affectedDays": rec.affected_days,
            "skippedManualDays": rec.skipped_manual_days,
        }
    }


# ═══════════════════════════════════════════════════════════════════════════
# 证券买卖 §4.2.6（含 §9.2 卖出硬校验）
# ═══════════════════════════════════════════════════════════════════════════
router_trades = APIRouter(
    prefix="/api/portfolios", tags=["security-trades"], route_class=EnvelopeRoute
)


@router_trades.get("/{portfolio_id}/security-trades", response_model=Paginated[TradeOut])
async def list_trades(
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    securityId: Optional[str] = None,
    side: Optional[str] = None,
    startDate: Optional[date] = None,
    endDate: Optional[date] = None,
    page: int = 1,
    pageSize: int = 20,
):
    stmt = await TradeService(db).list_stmt(
        p.id, securityId, side, startDate, endDate
    )
    return await paginate(db, stmt, page, pageSize, serialize_trade)


@router_trades.get("/{portfolio_id}/security-trades/{trade_id}", response_model=TradeOut)
async def get_trade(
    p=Depends(get_portfolio), db: AsyncSession = Depends(get_db), trade_id: str = ""
):
    trade = await TradeService(db).get(p.id, trade_id)
    return serialize_trade(trade)


@router_trades.post("/{portfolio_id}/security-trades", response_model=TradeOut)
async def create_trade(
    req: TradeCreateReq, p=Depends(get_portfolio), db: AsyncSession = Depends(get_db)
):
    trade = await TradeService(db).create(p.id, req)
    return serialize_trade(trade)


@router_trades.patch("/{portfolio_id}/security-trades/{trade_id}", response_model=TradeOut)
async def patch_trade(
    req: TradePatchReq,
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    trade_id: str = "",
):
    trade = await TradeService(db).patch(p.id, trade_id, req)
    return serialize_trade(trade)


@router_trades.delete("/{portfolio_id}/security-trades/{trade_id}")
async def delete_trade(
    p=Depends(get_portfolio), db: AsyncSession = Depends(get_db), trade_id: str = ""
):
    await TradeService(db).delete(p.id, trade_id)
    return None


# ═══════════════════════════════════════════════════════════════════════════
# 最新价 §4.2.7
# ═══════════════════════════════════════════════════════════════════════════
router_prices = APIRouter(
    prefix="/api/portfolios", tags=["security-prices"], route_class=EnvelopeRoute
)


@router_prices.get("/{portfolio_id}/security-prices", response_model=Paginated[PriceOut])
async def list_prices(
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    securityId: Optional[str] = None,
    page: int = 1,
    pageSize: int = 20,
):
    stmt = await PriceService(db).list_stmt(p.id, securityId)
    return await paginate(db, stmt, page, pageSize, serialize_price)


@router_prices.post("/{portfolio_id}/security-prices", response_model=PriceOut)
async def create_price(
    req: PriceCreateReq, p=Depends(get_portfolio), db: AsyncSession = Depends(get_db)
):
    price = await PriceService(db).create(p.id, req)
    return serialize_price(price)


@router_prices.patch("/{portfolio_id}/security-prices/{price_id}", response_model=PriceOut)
async def patch_price(
    req: PricePatchReq,
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    price_id: str = "",
):
    price = await PriceService(db).patch(p.id, price_id, req)
    return serialize_price(price)


@router_prices.delete("/{portfolio_id}/security-prices/{price_id}")
async def delete_price(
    p=Depends(get_portfolio), db: AsyncSession = Depends(get_db), price_id: str = ""
):
    await PriceService(db).delete(p.id, price_id)
    return None


# ═══════════════════════════════════════════════════════════════════════════
# 现金余额 §4.2.8（独立 · 零联动，但触发级联重算）
# ═══════════════════════════════════════════════════════════════════════════
router_cashbalances = APIRouter(
    prefix="/api/portfolios", tags=["cash-balances"], route_class=EnvelopeRoute
)


@router_cashbalances.get("/{portfolio_id}/cash-balances", response_model=Paginated[CashBalanceOut])
async def list_cashbalances(
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    asOf: Optional[date] = None,
    page: int = 1,
    pageSize: int = 20,
):
    stmt = await CashBalanceService(db).list_stmt(p.id, asOf)
    return await paginate(db, stmt, page, pageSize, serialize_cashbalance)


@router_cashbalances.post("/{portfolio_id}/cash-balances", response_model=CashBalanceOut)
async def create_cashbalance(
    req: CashBalanceCreateReq, p=Depends(get_portfolio), db: AsyncSession = Depends(get_db)
):
    cb = await CashBalanceService(db).create(p.id, req)
    return serialize_cashbalance(cb)


@router_cashbalances.patch("/{portfolio_id}/cash-balances/{cb_id}", response_model=CashBalanceOut)
async def patch_cashbalance(
    req: CashBalancePatchReq,
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    cb_id: str = "",
):
    cb = await CashBalanceService(db).patch(p.id, cb_id, req)
    return serialize_cashbalance(cb)


@router_cashbalances.delete("/{portfolio_id}/cash-balances/{cb_id}")
async def delete_cashbalance(
    p=Depends(get_portfolio), db: AsyncSession = Depends(get_db), cb_id: str = ""
):
    await CashBalanceService(db).delete(p.id, cb_id)
    return None


# ═══════════════════════════════════════════════════════════════════════════
# 总资产快照 §4.2.4（每日唯一；手工三路径 + 派生读取 derivedTotalAsset）
# ═══════════════════════════════════════════════════════════════════════════
router_snapshots = APIRouter(
    prefix="/api/portfolios", tags=["snapshots"], route_class=EnvelopeRoute
)


@router_snapshots.get("/{portfolio_id}/snapshots", response_model=Paginated[SnapshotOut])
async def list_snapshots(
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    startDate: Optional[date] = None,
    endDate: Optional[date] = None,
    source: Optional[SnapshotSource] = None,
    page: int = 1,
    pageSize: int = 20,
):
    items, total = await SnapshotService(db).list(
        p.id, startDate, endDate, source, page, pageSize
    )
    return {
        "items": [serialize_snapshot(s, derived_total=d) for s, d in items],
        "total": total,
        "page": page,
        "pageSize": pageSize,
    }


@router_snapshots.get("/{portfolio_id}/snapshots/{snap_date}", response_model=SnapshotOut)
async def get_snapshot_by_date(
    p=Depends(get_portfolio), db: AsyncSession = Depends(get_db), snap_date: date = None
):
    snap, derived = await SnapshotService(db).get_by_date(p.id, snap_date)
    return serialize_snapshot(snap, derived_total=derived)


@router_snapshots.post("/{portfolio_id}/snapshots", response_model=SnapshotOut)
async def create_snapshot(
    req: SnapshotCreateReq, p=Depends(get_portfolio), db: AsyncSession = Depends(get_db)
):
    snap, derived = await SnapshotService(db).create(p.id, req)
    return serialize_snapshot(snap, derived_total=derived)


@router_snapshots.patch("/{portfolio_id}/snapshots/{snap_id}", response_model=SnapshotOut)
async def patch_snapshot(
    req: SnapshotPatchReq,
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    snap_id: str = "",
):
    snap, derived = await SnapshotService(db).patch(p.id, snap_id, req)
    return serialize_snapshot(snap, derived_total=derived)


@router_snapshots.delete("/{portfolio_id}/snapshots/{snap_id}")
async def delete_snapshot(
    p=Depends(get_portfolio), db: AsyncSession = Depends(get_db), snap_id: str = ""
):
    await SnapshotService(db).delete(p.id, snap_id)
    return None


@router_snapshots.post("/{portfolio_id}/snapshots/{snap_date}/reset", response_model=SnapshotOut)
async def reset_snapshot(
    p=Depends(get_portfolio), db: AsyncSession = Depends(get_db), snap_date: date = None
):
    snap, derived = await SnapshotService(db).reset(p.id, snap_date)
    return serialize_snapshot(snap, derived_total=derived)
