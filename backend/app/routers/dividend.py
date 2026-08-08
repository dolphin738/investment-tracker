"""分红记录路由（§4.2.18）。

- GET/POST/PATCH/DELETE /api/portfolios/{portfolio_id}/dividends
- 分红不参与收益计算（C-08/D-02）：不写 CashFlow、不触发重算引擎。
- 二级隔离：securityId 必须属于同一组合（防跨组合挂载）。
- netAmount = amount - tax 由后端统一计算（K-2），不落库。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import BusinessErrorCode
from app.core.envelope import EnvelopeRoute
from app.core.exceptions import BusinessException
from app.core.security import CurrentUser, get_current_user
from app.db.database import get_db
from app.models import DividendRecord, Security
from app.models.enums import DividendType
from app.routers.common import get_portfolio, serialize_dividend
from app.schemas import DividendCreateReq, DividendPatchReq
from app.schemas_resp import DividendOut, Paginated


def _coerce_dtype(val: str) -> DividendType:
    try:
        return DividendType(val)
    except ValueError:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message=f"type 取值无效（应为 CASH / STOCK_DIVIDEND）：{val}",
            status_code=400,
        )


def _split_ids(raw: Optional[str]) -> Optional[list[str]]:
    if not raw:
        return None
    return [x for x in raw.split(",") if x]


async def _get_security(
    db: AsyncSession, portfolio_id: str, security_id: str
) -> Security:
    """二级隔离：证券必须属于本组合，否则 404。"""
    sec = await db.get(Security, security_id)
    if sec is None or sec.portfolio_id != portfolio_id:
        raise BusinessException(
            code=BusinessErrorCode.NOT_FOUND,
            message="标的不存在或不属于该组合",
            status_code=404,
        )
    return sec


def _assert_net_nonneg(amount: Decimal, tax: Decimal) -> None:
    if amount - tax < 0:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message="净额（amount - tax）不能为负",
            status_code=400,
        )


router_dividends = APIRouter(
    prefix="/api/portfolios", tags=["dividends"], route_class=EnvelopeRoute
)


@router_dividends.get("/{portfolio_id}/dividends", response_model=Paginated[DividendOut])
async def list_dividends(
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    securityId: Optional[str] = None,
    startDate: Optional[date] = None,
    endDate: Optional[date] = None,
    page: int = 1,
    pageSize: int = 50,
):
    stmt = select(DividendRecord).where(DividendRecord.portfolio_id == p.id)
    if securityId:
        ids = _split_ids(securityId)
        if ids:
            stmt = stmt.where(DividendRecord.security_id.in_(ids))
    if startDate:
        stmt = stmt.where(DividendRecord.date >= startDate)
    if endDate:
        stmt = stmt.where(DividendRecord.date <= endDate)
    stmt = stmt.order_by(
        DividendRecord.date.desc(), DividendRecord.created_at.desc()
    )
    total = (
        await db.execute(select(func.count()).select_from(stmt.subquery()))
    ).scalar_one()
    rows = (
        await db.execute(stmt.limit(pageSize).offset((page - 1) * pageSize))
    ).scalars().all()
    sec_ids = [r.security_id for r in rows]
    sec_map: dict[str, Security] = {}
    if sec_ids:
        secs = (
            await db.execute(select(Security).where(Security.id.in_(sec_ids)))
        ).scalars().all()
        sec_map = {s.id: s for s in secs}
    items = [serialize_dividend(r, sec_map.get(r.security_id)) for r in rows]
    return {
        "items": items,
        "total": total,
        "page": page,
        "pageSize": pageSize,
    }


@router_dividends.post("/{portfolio_id}/dividends", response_model=DividendOut)
async def create_dividend(
    req: DividendCreateReq,
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
):
    await _get_security(db, p.id, req.securityId)
    tax = req.tax if req.tax is not None else Decimal(0)
    _assert_net_nonneg(req.amount, tax)
    d = DividendRecord(
        portfolio_id=p.id,
        security_id=req.securityId,
        date=req.date,
        amount=req.amount,
        tax=tax,
        type=_coerce_dtype(req.type) if req.type is not None else DividendType.CASH,
        note=req.note,
    )
    db.add(d)
    await db.commit()
    await db.refresh(d)
    sec = await db.get(Security, d.security_id)
    return serialize_dividend(d, sec)


@router_dividends.patch("/{portfolio_id}/dividends/{div_id}", response_model=DividendOut)
async def patch_dividend(
    req: DividendPatchReq,
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    div_id: str = "",
):
    d = await db.get(DividendRecord, div_id)
    if d is None or d.portfolio_id != p.id:
        raise BusinessException(
            code=BusinessErrorCode.NOT_FOUND, message="分红记录不存在", status_code=404
        )
    sec_id = d.security_id
    amount = d.amount
    tax = d.tax
    if req.securityId is not None:
        await _get_security(db, p.id, req.securityId)
        sec_id = req.securityId
    if req.date is not None:
        d.date = req.date
    if req.amount is not None:
        amount = req.amount
    if req.tax is not None:
        tax = req.tax
    if req.type is not None:
        d.type = _coerce_dtype(req.type)
    if req.note is not None:
        d.note = req.note
    d.security_id = sec_id
    d.amount = amount
    d.tax = tax
    _assert_net_nonneg(d.amount, d.tax)
    await db.commit()
    await db.refresh(d)
    sec = await db.get(Security, d.security_id)
    return serialize_dividend(d, sec)


@router_dividends.delete("/{portfolio_id}/dividends/{div_id}")
async def delete_dividend(
    p=Depends(get_portfolio), db: AsyncSession = Depends(get_db), div_id: str = ""
):
    d = await db.get(DividendRecord, div_id)
    if d is None or d.portfolio_id != p.id:
        raise BusinessException(
            code=BusinessErrorCode.NOT_FOUND, message="分红记录不存在", status_code=404
        )
    await db.delete(d)
    await db.commit()
    return None
