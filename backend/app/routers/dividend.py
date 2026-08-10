"""分红记录路由（§4.2.18）。

- GET/POST/PATCH/DELETE /api/portfolios/{portfolio_id}/dividends
- 分红不参与收益计算（C-08/D-02）：不写 CashFlow、不触发重算引擎。
- 二级隔离：securityId 必须属于同一组合（防跨组合挂载）。
- netAmount = amount - tax 由后端统一计算（K-2），不落库。
"""
from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.envelope import EnvelopeRoute
from app.db.database import get_db
from app.models import Security
from app.routers.common import get_portfolio
from app.serializers import serialize_dividend
from app.schemas import DividendCreateReq, DividendPatchReq
from app.schemas_resp import DividendOut, Paginated
from app.services.dividend import DividendService


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
    rows, total = await DividendService(db).list(
        p.id, securityId, startDate, endDate, page, pageSize
    )
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
    d = await DividendService(db).create(p.id, req)
    sec = await db.get(Security, d.security_id)
    return serialize_dividend(d, sec)


@router_dividends.patch("/{portfolio_id}/dividends/{div_id}", response_model=DividendOut)
async def patch_dividend(
    req: DividendPatchReq,
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    div_id: str = "",
):
    d = await DividendService(db).patch(p.id, div_id, req)
    sec = await db.get(Security, d.security_id)
    return serialize_dividend(d, sec)


@router_dividends.delete("/{portfolio_id}/dividends/{div_id}")
async def delete_dividend(
    p=Depends(get_portfolio), db: AsyncSession = Depends(get_db), div_id: str = ""
):
    await DividendService(db).delete(p.id, div_id)
    return None
