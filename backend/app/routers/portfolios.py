"""组合管理路由 — 对齐 docs/ARCHITECTURE.md §4.2.2。

所有路由经 get_portfolio 依赖做归属隔离；/data 清空保留组合本身。
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.envelope import EnvelopeRoute
from app.core.security import CurrentUser, get_current_user
from app.db.database import get_db
from app.models import (
    AssetSnapshot,
    CashBalance,
    CashFlow,
    DailyNav,
    DailyXirr,
    Portfolio,
    SecurityPrice,
    SecurityTrade,
    UserPreference,
)
from app.core.enums import BusinessErrorCode
from app.core.exceptions import BusinessException
from app.routers.common import get_portfolio, serialize_portfolio, serialize_preference
from app.schemas import PortfolioArchiveReq, PortfolioCreateReq, PortfolioPatchReq
from app.schemas_resp import ClearDataOut, PortfolioOut, PreferenceOut

router = APIRouter(prefix="/api", tags=["portfolios"], route_class=EnvelopeRoute)


@router.get("/portfolios", response_model=list[PortfolioOut])
async def list_portfolios(
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list:
    rows = (
        await db.execute(
            select(Portfolio)
            .where(Portfolio.user_id == user.user_id)
            .order_by(Portfolio.created_at.desc())
        )
    ).scalars().all()
    return [serialize_portfolio(p) for p in rows]


@router.post("/portfolios", response_model=PortfolioOut)
async def create_portfolio(
    req: PortfolioCreateReq,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    p = Portfolio(
        user_id=user.user_id,
        name=req.name,
        description=req.description,
        currency=req.currency,
    )
    db.add(p)
    await db.commit()
    await db.refresh(p)
    return serialize_portfolio(p)


@router.get("/portfolios/{portfolio_id}", response_model=PortfolioOut)
async def get_portfolio_detail(p: Portfolio = Depends(get_portfolio)) -> dict:
    return serialize_portfolio(p)


@router.patch("/portfolios/{portfolio_id}", response_model=PortfolioOut)
async def patch_portfolio(
    req: PortfolioPatchReq,
    p: Portfolio = Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if req.name is not None:
        p.name = req.name
    if req.description is not None:
        p.description = req.description
    await db.commit()
    return serialize_portfolio(p)


@router.delete("/portfolios/{portfolio_id}")
async def delete_portfolio(
    p: Portfolio = Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
) -> None:
    await db.delete(p)
    await db.commit()
    return None


@router.delete("/portfolios/{portfolio_id}/data", response_model=ClearDataOut)
async def clear_data(
    p: Portfolio = Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """清空组合所有数据（保留组合本身）。级联删除子表。"""
    counts: dict[str, int] = {}
    for tbl in (
        DailyXirr,
        DailyNav,
        AssetSnapshot,
        CashFlow,
        SecurityTrade,
        SecurityPrice,
        CashBalance,
    ):
        res = await db.execute(delete(tbl).where(tbl.portfolio_id == p.id))
        counts[tbl.__tablename__] = int(res.rowcount or 0)
    await db.commit()
    return {"deletedCount": counts}


@router.patch("/portfolios/{portfolio_id}/archive", response_model=PortfolioOut)
async def archive_portfolio(
    req: PortfolioArchiveReq,
    p: Portfolio = Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """归档 / 取消归档（§4.2.2）。

    archived 缺省或 true → archivedAt = now；false → 置空。
    归档时若该组合为用户偏好默认组合，则同步置空（被隐藏的组合不能再当默认）。
    """
    archiving = req.archived is not False
    p.archived_at = datetime.now(timezone.utc) if archiving else None
    await db.commit()
    if archiving:
        await db.execute(
            update(UserPreference)
            .where(
                UserPreference.user_id == p.user_id,
                UserPreference.default_portfolio_id == p.id,
            )
            .values(default_portfolio_id=None)
        )
        await db.commit()
    return serialize_portfolio(p)


@router.patch("/portfolios/{portfolio_id}/default", response_model=PreferenceOut)
async def set_default_portfolio(
    p: Portfolio = Depends(get_portfolio),
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """五角星设为默认 / 再次点击取消默认（toggle，需求项6）。

    复用 get_portfolio 依赖保证归属；单字段天然互斥，无需清空其它组合。
    """
    pref = (
        await db.execute(
            select(UserPreference).where(UserPreference.user_id == user.user_id)
        )
    ).scalar_one_or_none()
    if pref is None:
        pref = UserPreference(user_id=user.user_id)
        db.add(pref)
    pref.default_portfolio_id = None if pref.default_portfolio_id == p.id else p.id
    await db.commit()
    await db.refresh(pref)
    return serialize_preference(pref)
