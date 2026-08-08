"""数据实体路由（CRUD + 写操作级联重算）。

覆盖 docs/ARCHITECTURE.md §4.2.3~§4.2.8：cashflows / securities / security-trades /
security-prices / cash-balances / snapshots。所有写操作经 RecalculationService 统一
入口触发区间重建或级联（§7.3 / §8 / REG-06）。

组合归属隔离由 get_portfolio 保证；证券标的级联删除由 FK ondelete=CASCADE 保证。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import BusinessErrorCode
from app.core.envelope import EnvelopeRoute
from app.core.exceptions import BusinessException
from app.core.security import CurrentUser, get_current_user
from app.db.database import get_db
from app.finance_core.holding import ZERO
from app.models import (
    AssetSnapshot,
    CashBalance,
    CashFlow,
    Security,
    SecurityPrice,
    SecurityTrade,
    SnapshotSource,
)
from app.models.enums import (
    CashFlowType,
    SecuritySide,
    SecurityType,
    SnapshotValuation,
)
from app.routers.common import (
    get_portfolio,
    paginate,
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
from app.services.asset_valuation import AssetValuationService
from app.services.holding import HoldingService
from app.services.recalculation import RecalculationService


def _coerce(cls, val: str, field: str):
    try:
        return cls(val)
    except ValueError:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message=f"{field} 取值无效：{val}",
            status_code=400,
        )


async def _assert_sell_ok(
    db: AsyncSession,
    portfolio_id: str,
    security_id: str,
    as_of: date,
    quantity: Decimal,
    exclude_trade_id: str | None = None,
) -> None:
    """§9.2 卖出硬校验：卖出量不得超过当前持仓（含未来日期）。"""
    held = await HoldingService(db).derive(
        portfolio_id,
        as_of,
        include_closed=True,
        security_id=security_id,
        exclude_trade_id=exclude_trade_id,
    )
    view = next((h for h in held if h.security_id == security_id), None)
    current = view.quantity if view is not None else ZERO
    if quantity > current:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message=f"当前持有 {current}，最多可卖 {current}",
            status_code=400,
        )


def _split_ids(raw: Optional[str]) -> Optional[list[str]]:
    if not raw:
        return None
    return [x for x in raw.split(",") if x]


# ═══════════════════════════════════════════════════════════════════════════
# 出入金 §4.2.3
# ═══════════════════════════════════════════════════════════════════════════
router_cashflows = APIRouter(
    prefix="/api/portfolios", tags=["cashflows"], route_class=EnvelopeRoute
)


@router_cashflows.get("/{portfolio_id}/cashflows")
async def list_cashflows(
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    startDate: Optional[date] = None,
    endDate: Optional[date] = None,
    page: int = 1,
    pageSize: int = 20,
):
    stmt = select(CashFlow).where(CashFlow.portfolio_id == p.id)
    if startDate:
        stmt = stmt.where(CashFlow.date >= startDate)
    if endDate:
        stmt = stmt.where(CashFlow.date <= endDate)
    stmt = stmt.order_by(CashFlow.date.desc(), CashFlow.created_at.desc())
    return await paginate(db, stmt, page, pageSize, serialize_cashflow)


@router_cashflows.post("/{portfolio_id}/cashflows")
async def create_cashflow(
    req: CashflowCreateReq, p=Depends(get_portfolio), db: AsyncSession = Depends(get_db)
):
    cf = CashFlow(
        portfolio_id=p.id,
        date=req.date,
        type=_coerce(CashFlowType, req.type, "type"),
        amount=req.amount,
        note=req.note,
    )
    db.add(cf)
    await db.commit()
    await RecalculationService(db).recalculateRange(p.id, req.date)
    return serialize_cashflow(cf)


@router_cashflows.patch("/{portfolio_id}/cashflows/{cf_id}")
async def patch_cashflow(
    req: CashflowPatchReq,
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    cf_id: str = "",
):
    cf = await db.get(CashFlow, cf_id)
    if cf is None or cf.portfolio_id != p.id:
        raise BusinessException(BusinessErrorCode.NOT_FOUND, "出入金不存在", status_code=404)
    old_date = cf.date
    if req.date is not None:
        cf.date = req.date
    if req.type is not None:
        cf.type = _coerce(CashFlowType, req.type, "type")
    if req.amount is not None:
        cf.amount = req.amount
    if req.note is not None:
        cf.note = req.note
    await db.commit()
    await RecalculationService(db).recalculateRange(p.id, min(cf.date, old_date))
    return serialize_cashflow(cf)


@router_cashflows.delete("/{portfolio_id}/cashflows/{cf_id}")
async def delete_cashflow(
    p=Depends(get_portfolio), db: AsyncSession = Depends(get_db), cf_id: str = ""
):
    cf = await db.get(CashFlow, cf_id)
    if cf is None or cf.portfolio_id != p.id:
        raise BusinessException(BusinessErrorCode.NOT_FOUND, "出入金不存在", status_code=404)
    d = cf.date
    await db.delete(cf)
    await db.commit()
    await RecalculationService(db).recalculateRange(p.id, d)
    return None


# ═══════════════════════════════════════════════════════════════════════════
# 标的 §4.2.5
# ═══════════════════════════════════════════════════════════════════════════
router_securities = APIRouter(
    prefix="/api/portfolios", tags=["securities"], route_class=EnvelopeRoute
)


@router_securities.get("/{portfolio_id}/securities")
async def list_securities(
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    page: int = 1,
    pageSize: int = 20,
):
    stmt = (
        select(Security)
        .where(Security.portfolio_id == p.id)
        .order_by(Security.created_at.desc())
    )
    return await paginate(db, stmt, page, pageSize, serialize_security)


@router_securities.post("/{portfolio_id}/securities")
async def create_security(
    req: SecurityCreateReq, p=Depends(get_portfolio), db: AsyncSession = Depends(get_db)
):
    sec = Security(
        portfolio_id=p.id,
        code=req.code,
        name=req.name,
        type=_coerce(SecurityType, req.type, "type"),
        currency=req.currency,
    )
    db.add(sec)
    await db.commit()
    await db.refresh(sec)
    return serialize_security(sec)


@router_securities.patch("/{portfolio_id}/securities/{sec_id}")
async def patch_security(
    req: SecurityPatchReq,
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    sec_id: str = "",
):
    sec = await db.get(Security, sec_id)
    if sec is None or sec.portfolio_id != p.id:
        raise BusinessException(BusinessErrorCode.NOT_FOUND, "标的不存在", status_code=404)
    if req.name is not None:
        sec.name = req.name
    if req.type is not None:
        sec.type = _coerce(SecurityType, req.type, "type")
    await db.commit()
    return serialize_security(sec)


@router_securities.delete("/{portfolio_id}/securities/{sec_id}")
async def delete_security(
    p=Depends(get_portfolio), db: AsyncSession = Depends(get_db), sec_id: str = ""
):
    sec = await db.get(Security, sec_id)
    if sec is None or sec.portfolio_id != p.id:
        raise BusinessException(BusinessErrorCode.NOT_FOUND, "标的不存在", status_code=404)
    # 删除前收集该标的成交日（用于强制重算受影响 DERIVED 快照）
    trade_dates = (
        await db.execute(
            select(SecurityTrade.date).where(
                SecurityTrade.portfolio_id == p.id,
                SecurityTrade.security_id == sec_id,
            )
        )
    ).scalars().all()
    await db.delete(sec)  # 级联删 trades/prices
    await db.commit()
    if trade_dates:
        await RecalculationService(db).recalculateRange(
            p.id, min(trade_dates), force_dates=sorted(set(trade_dates))
        )
    return None


# ═══════════════════════════════════════════════════════════════════════════
# 证券买卖 §4.2.6（含 §9.2 卖出硬校验）
# ═══════════════════════════════════════════════════════════════════════════
router_trades = APIRouter(
    prefix="/api/portfolios", tags=["security-trades"], route_class=EnvelopeRoute
)


@router_trades.get("/{portfolio_id}/security-trades")
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
    stmt = select(SecurityTrade).where(SecurityTrade.portfolio_id == p.id)
    if securityId:
        ids = _split_ids(securityId)
        if ids:
            stmt = stmt.where(SecurityTrade.security_id.in_(ids))
    if side:
        stmt = stmt.where(SecurityTrade.side == _coerce(SecuritySide, side, "side"))
    if startDate:
        stmt = stmt.where(SecurityTrade.date >= startDate)
    if endDate:
        stmt = stmt.where(SecurityTrade.date <= endDate)
    stmt = stmt.order_by(SecurityTrade.date.desc(), SecurityTrade.created_at.desc())
    return await paginate(db, stmt, page, pageSize, serialize_trade)


@router_trades.post("/{portfolio_id}/security-trades")
async def create_trade(
    req: TradeCreateReq, p=Depends(get_portfolio), db: AsyncSession = Depends(get_db)
):
    side = _coerce(SecuritySide, req.side, "side")
    if side is SecuritySide.SELL_SEC:
        await _assert_sell_ok(
            db, p.id, req.securityId, req.date, req.quantity
        )
    trade = SecurityTrade(
        portfolio_id=p.id,
        security_id=req.securityId,
        date=req.date,
        side=side,
        quantity=req.quantity,
        cost_price=req.price,
        fee_total=req.fee or Decimal(0),
    )
    db.add(trade)
    await db.commit()
    force = await RecalculationService(db).snapshot_dates_since(p.id, req.date)
    await RecalculationService(db).recalculateRange(p.id, req.date, force_dates=force)
    return serialize_trade(trade)


@router_trades.patch("/{portfolio_id}/security-trades/{trade_id}")
async def patch_trade(
    req: TradePatchReq,
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    trade_id: str = "",
):
    trade = await db.get(SecurityTrade, trade_id)
    if trade is None or trade.portfolio_id != p.id:
        raise BusinessException(BusinessErrorCode.NOT_FOUND, "买卖流水不存在", status_code=404)
    old_date = trade.date
    new_date = req.date if req.date is not None else trade.date
    new_side = (
        _coerce(SecuritySide, req.side, "side") if req.side is not None else trade.side
    )
    new_qty = req.quantity if req.quantity is not None else trade.quantity
    if new_side is SecuritySide.SELL_SEC:
        await _assert_sell_ok(
            db,
            p.id,
            trade.security_id,
            new_date,
            new_qty,
            exclude_trade_id=trade.id,
        )
    if req.date is not None:
        trade.date = req.date
    if req.quantity is not None:
        trade.quantity = req.quantity
    if req.price is not None:
        trade.cost_price = req.price
    if req.fee is not None:
        trade.fee_total = req.fee
    await db.commit()
    force = await RecalculationService(db).snapshot_dates_since(p.id, new_date)
    await RecalculationService(db).recalculateRange(
        p.id, min(new_date, old_date), force_dates=force
    )
    return serialize_trade(trade)


@router_trades.delete("/{portfolio_id}/security-trades/{trade_id}")
async def delete_trade(
    p=Depends(get_portfolio), db: AsyncSession = Depends(get_db), trade_id: str = ""
):
    trade = await db.get(SecurityTrade, trade_id)
    if trade is None or trade.portfolio_id != p.id:
        raise BusinessException(BusinessErrorCode.NOT_FOUND, "买卖流水不存在", status_code=404)
    d = trade.date
    await db.delete(trade)
    await db.commit()
    force = await RecalculationService(db).snapshot_dates_since(p.id, d)
    await RecalculationService(db).recalculateRange(p.id, d, force_dates=force)
    return None


# ═══════════════════════════════════════════════════════════════════════════
# 最新价 §4.2.7
# ═══════════════════════════════════════════════════════════════════════════
router_prices = APIRouter(
    prefix="/api/portfolios", tags=["security-prices"], route_class=EnvelopeRoute
)


@router_prices.get("/{portfolio_id}/security-prices")
async def list_prices(
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    securityId: Optional[str] = None,
    page: int = 1,
    pageSize: int = 20,
):
    stmt = select(SecurityPrice).where(SecurityPrice.portfolio_id == p.id)
    if securityId:
        ids = _split_ids(securityId)
        if ids:
            stmt = stmt.where(SecurityPrice.security_id.in_(ids))
    stmt = stmt.order_by(SecurityPrice.as_of.desc(), SecurityPrice.created_at.desc())
    return await paginate(db, stmt, page, pageSize, serialize_price)


@router_prices.post("/{portfolio_id}/security-prices")
async def create_price(
    req: PriceCreateReq, p=Depends(get_portfolio), db: AsyncSession = Depends(get_db)
):
    price = SecurityPrice(
        portfolio_id=p.id,
        security_id=req.securityId,
        price=req.price,
        as_of=req.asOf,
    )
    db.add(price)
    await db.commit()
    force = await RecalculationService(db).snapshot_dates_since(p.id, req.asOf)
    await RecalculationService(db).recalculateRange(p.id, req.asOf, force_dates=force)
    return serialize_price(price)


@router_prices.patch("/{portfolio_id}/security-prices/{price_id}")
async def patch_price(
    req: PricePatchReq,
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    price_id: str = "",
):
    price = await db.get(SecurityPrice, price_id)
    if price is None or price.portfolio_id != p.id:
        raise BusinessException(BusinessErrorCode.NOT_FOUND, "现价不存在", status_code=404)
    old_as_of = price.as_of
    new_as_of = req.asOf if req.asOf is not None else price.as_of
    if req.price is not None:
        price.price = req.price
    if req.asOf is not None:
        price.as_of = req.asOf
    await db.commit()
    force = await RecalculationService(db).snapshot_dates_since(p.id, new_as_of)
    await RecalculationService(db).recalculateRange(
        p.id, min(new_as_of, old_as_of), force_dates=force
    )
    return serialize_price(price)


@router_prices.delete("/{portfolio_id}/security-prices/{price_id}")
async def delete_price(
    p=Depends(get_portfolio), db: AsyncSession = Depends(get_db), price_id: str = ""
):
    price = await db.get(SecurityPrice, price_id)
    if price is None or price.portfolio_id != p.id:
        raise BusinessException(BusinessErrorCode.NOT_FOUND, "现价不存在", status_code=404)
    d = price.as_of
    await db.delete(price)
    await db.commit()
    force = await RecalculationService(db).snapshot_dates_since(p.id, d)
    await RecalculationService(db).recalculateRange(p.id, d, force_dates=force)
    return None


# ═══════════════════════════════════════════════════════════════════════════
# 现金余额 §4.2.8（独立 · 零联动，但触发级联重算）
# ═══════════════════════════════════════════════════════════════════════════
router_cashbalances = APIRouter(
    prefix="/api/portfolios", tags=["cash-balances"], route_class=EnvelopeRoute
)


@router_cashbalances.get("/{portfolio_id}/cash-balances")
async def list_cashbalances(
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    asOf: Optional[date] = None,
    page: int = 1,
    pageSize: int = 20,
):
    stmt = select(CashBalance).where(CashBalance.portfolio_id == p.id)
    if asOf:
        stmt = stmt.where(CashBalance.as_of == asOf)
    stmt = stmt.order_by(CashBalance.as_of.desc(), CashBalance.created_at.desc())
    return await paginate(db, stmt, page, pageSize, serialize_cashbalance)


@router_cashbalances.post("/{portfolio_id}/cash-balances")
async def create_cashbalance(
    req: CashBalanceCreateReq, p=Depends(get_portfolio), db: AsyncSession = Depends(get_db)
):
    cb = CashBalance(
        portfolio_id=p.id, amount=req.amount, as_of=req.asOf, note=req.note
    )
    db.add(cb)
    await db.commit()
    force = await RecalculationService(db).snapshot_dates_since(p.id, req.asOf)
    await RecalculationService(db).recalculateRange(p.id, req.asOf, force_dates=force)
    return serialize_cashbalance(cb)


@router_cashbalances.patch("/{portfolio_id}/cash-balances/{cb_id}")
async def patch_cashbalance(
    req: CashBalancePatchReq,
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    cb_id: str = "",
):
    cb = await db.get(CashBalance, cb_id)
    if cb is None or cb.portfolio_id != p.id:
        raise BusinessException(BusinessErrorCode.NOT_FOUND, "现金余额不存在", status_code=404)
    old_as_of = cb.as_of
    if req.amount is not None:
        cb.amount = req.amount
    if req.note is not None:
        cb.note = req.note
    await db.commit()
    force = await RecalculationService(db).snapshot_dates_since(p.id, old_as_of)
    await RecalculationService(db).recalculateRange(p.id, old_as_of, force_dates=force)
    return serialize_cashbalance(cb)


@router_cashbalances.delete("/{portfolio_id}/cash-balances/{cb_id}")
async def delete_cashbalance(
    p=Depends(get_portfolio), db: AsyncSession = Depends(get_db), cb_id: str = ""
):
    cb = await db.get(CashBalance, cb_id)
    if cb is None or cb.portfolio_id != p.id:
        raise BusinessException(BusinessErrorCode.NOT_FOUND, "现金余额不存在", status_code=404)
    d = cb.as_of
    await db.delete(cb)
    await db.commit()
    force = await RecalculationService(db).snapshot_dates_since(p.id, d)
    await RecalculationService(db).recalculateRange(p.id, d, force_dates=force)
    return None


# ═══════════════════════════════════════════════════════════════════════════
# 总资产快照 §4.2.4（每日唯一；手工三路径 + 派生读取 derivedTotalAsset）
# ═══════════════════════════════════════════════════════════════════════════
router_snapshots = APIRouter(
    prefix="/api/portfolios", tags=["snapshots"], route_class=EnvelopeRoute
)


@router_snapshots.get("/{portfolio_id}/snapshots")
async def list_snapshots(
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    startDate: Optional[date] = None,
    endDate: Optional[date] = None,
    page: int = 1,
    pageSize: int = 20,
):
    from sqlalchemy import func

    base = select(AssetSnapshot).where(AssetSnapshot.portfolio_id == p.id)
    if startDate:
        base = base.where(AssetSnapshot.date >= startDate)
    if endDate:
        base = base.where(AssetSnapshot.date <= endDate)
    total = (
        await db.execute(
            select(func.count()).select_from(base.subquery())
        )
    ).scalar_one()
    rows = (
        await db.execute(
            base.order_by(AssetSnapshot.date.desc())
            .limit(pageSize)
            .offset((page - 1) * pageSize)
        )
    ).scalars().all()
    # N+1 规避：仅对 MANUAL 行批量计算 derivedTotalAsset
    manual_dates = [r.date for r in rows if r.source is SnapshotSource.MANUAL]
    derived_map: dict[date, object] = {}
    if manual_dates:
        batch = await AssetValuationService(db).computeDerivedBatch(p.id, manual_dates)
        derived_map = {d: b.total_asset for d, b in batch.items()}
    items = [
        serialize_snapshot(
            r,
            derived_total=(
                r.total_asset
                if r.source is SnapshotSource.DERIVED
                else derived_map.get(r.date)
            ),
        )
        for r in rows
    ]
    return {"items": items, "total": total, "page": page, "pageSize": pageSize}


@router_snapshots.get("/{portfolio_id}/snapshots/{snap_date}")
async def get_snapshot_by_date(
    p=Depends(get_portfolio), db: AsyncSession = Depends(get_db), snap_date: date = None
):
    snap = (
        await db.execute(
            select(AssetSnapshot).where(
                AssetSnapshot.portfolio_id == p.id, AssetSnapshot.date == snap_date
            )
        )
    ).scalar_one_or_none()
    if snap is None:
        raise BusinessException(BusinessErrorCode.NOT_FOUND, "该日无总资产记录", status_code=404)
    if snap.source is SnapshotSource.DERIVED:
        derived = snap.total_asset
    else:
        derived = (await AssetValuationService(db).computeDerived(p.id, snap_date)).total_asset
    return serialize_snapshot(snap, derived_total=derived)


@router_snapshots.post("/{portfolio_id}/snapshots")
async def create_snapshot(
    req: SnapshotCreateReq, p=Depends(get_portfolio), db: AsyncSession = Depends(get_db)
):
    av = AssetValuationService(db)
    snap = await av.upsertManual(
        p.id, req.date, req.totalAsset, req.marketValue, req.cashBalance, req.note
    )
    await db.flush()
    await RecalculationService(db).recalculateNavRange(p.id, req.date)
    derived = (await av.computeDerived(p.id, req.date)).total_asset
    return serialize_snapshot(snap, derived_total=derived)


@router_snapshots.patch("/{portfolio_id}/snapshots/{snap_id}")
async def patch_snapshot(
    req: SnapshotPatchReq,
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    snap_id: str = "",
):
    snap = await db.get(AssetSnapshot, snap_id)
    if snap is None or snap.portfolio_id != p.id:
        raise BusinessException(BusinessErrorCode.NOT_FOUND, "总资产记录不存在", status_code=404)
    old_date = snap.date
    if req.totalAsset is not None:
        snap.total_asset = req.totalAsset
    if req.marketValue is not None:
        snap.market_value = req.marketValue
    if req.cashBalance is not None:
        snap.cash_balance = req.cashBalance
    if req.note is not None:
        snap.note = req.note
    # 手工覆盖：source 改写为 MANUAL
    snap.source = SnapshotSource.MANUAL
    snap.valuation_flag = SnapshotValuation.MANUAL_INPUT
    await db.flush()
    await RecalculationService(db).recalculateNavRange(p.id, min(snap.date, old_date))
    av = AssetValuationService(db)
    derived = (await av.computeDerived(p.id, snap.date)).total_asset
    return serialize_snapshot(snap, derived_total=derived)


@router_snapshots.delete("/{portfolio_id}/snapshots/{snap_id}")
async def delete_snapshot(
    p=Depends(get_portfolio), db: AsyncSession = Depends(get_db), snap_id: str = ""
):
    snap = await db.get(AssetSnapshot, snap_id)
    if snap is None or snap.portfolio_id != p.id:
        raise BusinessException(BusinessErrorCode.NOT_FOUND, "总资产记录不存在", status_code=404)
    d = snap.date
    await AssetValuationService(db).deleteRecord(p.id, d)
    await db.flush()
    await RecalculationService(db).recalculateNavRange(p.id, d)
    return None


@router_snapshots.post("/{portfolio_id}/snapshots/{snap_date}/reset")
async def reset_snapshot(
    p=Depends(get_portfolio), db: AsyncSession = Depends(get_db), snap_date: date = None
):
    av = AssetValuationService(db)
    snap = await av.resetToDerived(p.id, snap_date)
    await db.flush()
    await RecalculationService(db).recalculateNavRange(p.id, snap_date)
    return serialize_snapshot(snap, derived_total=snap.total_asset)
