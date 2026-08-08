"""聚合端点路由 — 对齐 docs/ARCHITECTURE.md §4.2.10/§4.2.14/§4.2.15/§4.2.16。

- /api/portfolios/comparison           多组合对比摘要（一次查询，当前用户）
- /api/portfolios/{id}/summary         关键指标摘要
- /api/portfolios/{id}/overview        核心指标 + 趋势（Dashboard 落地页）
- /api/portfolios/{id}/metrics/drawdown 最大回撤时间序列
- /api/account/stats                   账户统计（组合数/总资产/累计XIRR/当年XIRR）

⚠️ /comparison 为字面路由，必须在 main.py 中于 portfolios.router 之前注册，
否则会被 portfolios 的 /{portfolio_id} 参数路由吞掉。
"""
from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.envelope import EnvelopeRoute
from app.core.security import CurrentUser, get_current_user
from app.db.database import get_db
from app.routers.common import get_portfolio
from app.services.aggregation import AggregationService

router_aggregation = APIRouter(
    prefix="/api/portfolios", tags=["aggregation"], route_class=EnvelopeRoute
)
router_account = APIRouter(prefix="/api", tags=["account"], route_class=EnvelopeRoute)


@router_aggregation.get("/comparison")
async def comparison(
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await AggregationService(db).comparison(user.user_id)


@router_aggregation.get("/{portfolio_id}/summary")
async def summary(
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
):
    return await AggregationService(db).portfolio_summary(p)


@router_aggregation.get("/{portfolio_id}/overview")
async def overview(
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    range: str = Query("1y", description="1w|1m|3m|6m|1y|ytd|all"),
):
    return await AggregationService(db).overview(p, range)


@router_aggregation.get("/{portfolio_id}/metrics/drawdown")
async def drawdown(
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    startDate: Optional[date] = None,
    endDate: Optional[date] = None,
):
    return await AggregationService(db).drawdown(p.id, startDate, endDate)


@router_account.get("/account/stats")
async def account_stats(
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await AggregationService(db).account_stats(user.user_id)
