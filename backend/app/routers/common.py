"""路由公共依赖：组合归属隔离、分页、ORM→dict 序列化。"""
from __future__ import annotations

from datetime import date
from typing import Awaitable, Callable

from fastapi import Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import BusinessErrorCode
from app.core.exceptions import BusinessException
from app.core.security import CurrentUser, get_current_user
from app.db.database import get_db
from app.models import (
    AssetSnapshot,
    CashBalance,
    CashFlow,
    Portfolio,
    Security,
    SecurityPrice,
    SecurityTrade,
)
from app.models.enums import DividendType, SnapshotSource


async def get_portfolio(
    portfolio_id: str,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Portfolio:
    """组合归属隔离：非本人或不存在 → 404（不泄露存在性）。"""
    p = await db.get(Portfolio, portfolio_id)
    if p is None or p.user_id != user.user_id:
        raise BusinessException(
            code=BusinessErrorCode.NOT_FOUND, message="组合不存在", status_code=404
        )
    return p


async def paginate(
    session: AsyncSession,
    stmt,
    page: int,
    page_size: int,
    serializer: Callable,
) -> dict:
    total = (
        await session.execute(select(func.count()).select_from(stmt.subquery()))
    ).scalar_one()
    rows = (
        await session.execute(stmt.limit(page_size).offset((page - 1) * page_size))
    ).scalars().all()
    return {
        "items": [serializer(r) for r in rows],
        "total": total,
        "page": page,
        "pageSize": page_size,
    }


# ── 序列化 ──
def serialize_portfolio(p: Portfolio) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "description": p.description,
        "baseDate": p.base_date,
        "currency": p.currency,
        "createdAt": p.created_at,
        "updatedAt": p.updated_at,
    }


def serialize_cashflow(c: CashFlow) -> dict:
    return {
        "id": c.id,
        "date": c.date,
        "type": c.type.value,
        "amount": c.amount,
        "note": c.note,
        "createdAt": c.created_at,
    }


def serialize_security(s: Security) -> dict:
    return {
        "id": s.id,
        "code": s.code,
        "name": s.name,
        "type": s.type.value,
        "currency": s.currency,
        "createdAt": s.created_at,
    }


def serialize_trade(t: SecurityTrade) -> dict:
    return {
        "id": t.id,
        "securityId": t.security_id,
        "date": t.date,
        "side": t.side.value,
        "quantity": t.quantity,
        "price": t.cost_price,
        "fee": t.fee_total,
        "note": t.note,
        "createdAt": t.created_at,
    }


def serialize_price(p: SecurityPrice) -> dict:
    return {
        "id": p.id,
        "securityId": p.security_id,
        "price": p.price,
        "asOf": p.as_of,
        "createdAt": p.created_at,
    }


def serialize_cashbalance(c: CashBalance) -> dict:
    return {
        "id": c.id,
        "amount": c.amount,
        "asOf": c.as_of,
        "note": c.note,
        "createdAt": c.created_at,
    }


def serialize_snapshot(s: AssetSnapshot, derived_total=None) -> dict:
    return {
        "id": s.id,
        "date": s.date,
        "totalAsset": s.total_asset,
        "marketValue": s.market_value,
        "cashBalance": s.cash_balance,
        "source": s.source.value,
        "valuationFlag": s.valuation_flag.value,
        "note": s.note,
        "recordedAt": s.recorded_at,
        "derivedTotalAsset": derived_total,
    }


def serialize_dividend(d, sec=None) -> dict:
    sec_code = sec.code if sec is not None else None
    sec_name = sec.name if sec is not None else None
    net = d.amount - d.tax
    return {
        "id": d.id,
        "securityId": d.security_id,
        "securityCode": sec_code,
        "securityName": sec_name,
        "date": d.date,
        "amount": d.amount,
        "tax": d.tax,
        "netAmount": net,
        "type": d.type.value if isinstance(d.type, DividendType) else d.type,
        "note": d.note,
        "createdAt": d.created_at,
    }


def serialize_preference(p) -> dict:
    return {
        "id": p.id,
        "defaultPortfolioId": p.default_portfolio_id,
        "defaultGranularity": p.default_granularity,
        "defaultDateRange": p.default_date_range,
        "aggregation": p.aggregation,
        "weekStartsOn": p.week_starts_on,
        "navDecimals": p.nav_decimals,
        "xirrDecimals": p.xirr_decimals,
        "theme": p.theme,
        "staleDays": p.stale_days,
        "showLiquidated": p.show_liquidated,
        "costBasisView": p.cost_basis_view,
        "cashHintOnCashflow": p.cash_hint_on_cashflow,
        "cashHintOnTrade": p.cash_hint_on_trade,
        "amountThousands": p.amount_thousands,
        "amountAbbrev": p.amount_abbrev,
        "dashboardLayout": p.dashboard_layout,
    }
