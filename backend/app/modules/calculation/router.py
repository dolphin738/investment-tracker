"""计算读取与重算路由 — 对齐 docs/ARCHITECTURE.md §4.2.9~§4.2.15。

- holdings：实时推导（只读，无 CRUD），含 pnl/ratio。
- xirr / nav：时间序列（granularity/aggregation/metric）+ latest。
- recalculate：区间重算 / 全量重算（统一入口）。

本模块仅保留 4 个 router 与端点实现；非端点纯函数（分桶 / 聚合 / 历史加载 / 小工具）
已位移至 ``._helpers`` 并在此原样重导出，保证端点装饰器与签名零变化 → openapi 契约零 diff。
"""
from __future__ import annotations

import time
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.envelope import EnvelopeRoute
from app.db.database import get_db
from app.finance_core.holding import ZERO
from app.models import DailyNav, DailyXirr, PortfolioSecurity, SecurityPrice
from app.common import get_portfolio
from app.schemas import RecalculateRangeReq
from app.schemas_resp import (
    HoldingsOut,
    NavPointOut,
    Paginated,
    RecalcOut,
    XirrLatestOut,
    XirrPointOut,
)
from app.services.holding import HoldingService
from app.services.recalculation import RecalculationService
from app.services.security import compute_type

from ._helpers import (
    _agg,
    _bucket,
    _bucket_date,
    _bucket_nav,
    _bucket_xirr,
    _first_event_date,
    _load_nav_rows,
    _load_xirr_rows,
    _period_key,
    _split_ids,
    _today,
)


# ── 持仓 §4.2.9 ──
router_holdings = APIRouter(
    prefix="/api/portfolios", tags=["holdings"], route_class=EnvelopeRoute
)


@router_holdings.get("/{portfolio_id}/holdings", response_model=HoldingsOut)
async def get_holdings(
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    asOf: Optional[date] = None,
    securityId: Optional[str] = None,
    includeClosed: bool = False,
    types: Optional[str] = None,
):
    as_of = asOf or _today()
    sec_ids = _split_ids(securityId)
    single_id = sec_ids[0] if sec_ids and len(sec_ids) == 1 else None
    views = await HoldingService(db).derive(
        p.id,
        as_of,
        include_closed=includeClosed,
        security_id=single_id,
    )
    if sec_ids and len(sec_ids) > 1:
        wanted = set(sec_ids)
        views = [v for v in views if v.security_id in wanted]
    # 标的元数据（类型筛选 + 列表展示共用）：组合持仓 → master（目录）
    holdings = (
        await db.execute(
            select(PortfolioSecurity)
            .where(PortfolioSecurity.portfolio_id == p.id)
            .options(selectinload(PortfolioSecurity.master))
        )
    ).scalars().all()
    sec_map = {h.id: h for h in holdings}
    # 类型筛选（修复问题4：此前未接收后端参数 → 持仓页类型筛选器无效）。
    # types 为逗号分隔的 SecurityType 值（如 "STOCK,ON_EXCHANGE_FUND"），按 compute_type
    # （override 优先，否则代码前缀推断）过滤。
    type_set = (
        {t.strip().upper() for t in types.split(",") if t.strip()} if types else None
    )
    if type_set:
        views = [
            v
            for v in views
            if (h := sec_map.get(v.security_id)) is not None
            and compute_type(h).value in type_set
        ]
    # 各标的现价日期（as_of 前最后一条 SecurityPrice.as_of）
    price_rows = (
        await db.execute(
            select(SecurityPrice.security_id, func.max(SecurityPrice.as_of))
            .where(SecurityPrice.portfolio_id == p.id, SecurityPrice.as_of <= as_of)
            .group_by(SecurityPrice.security_id)
        )
    ).all()
    price_as_of_map = {sid: d for sid, d in price_rows}

    items: list[dict] = []
    total_mv = ZERO
    total_cost = ZERO
    total_pnl = ZERO
    for v in views:
        pnl = v.market_value - v.cost_total
        ratio = (pnl / v.cost_total) if v.cost_total != ZERO else ZERO
        h = sec_map.get(v.security_id)
        master = h.master if h is not None else None
        sec_code = master.code if master is not None else ""
        sec_name = master.name if master is not None else ""
        sec_type = compute_type(h).value if h is not None else ""
        price_as_of = price_as_of_map.get(v.security_id)
        items.append(
            {
                "securityId": v.security_id,
                "securityCode": sec_code,
                "securityName": sec_name,
                "securityType": sec_type,
                "quantity": str(v.quantity),
                "avgCost": str(v.avg_cost),
                "costTotal": str(v.cost_total),
                "marketPrice": str(v.price) if v.price is not None else None,
                "priceAsOf": price_as_of.isoformat() if price_as_of else None,
                "marketValue": str(v.market_value),
                "pnl": str(pnl),
                "pnlRate": str(ratio),
                "flag": "COST_BASED" if v.is_cost_based else "EXACT",
            }
        )
        total_mv += v.market_value
        total_cost += v.cost_total
        total_pnl += pnl
    total_rate = (total_pnl / total_cost) if total_cost != ZERO else ZERO
    aggregate = {
        "totalMarketValue": str(total_mv),
        "totalCost": str(total_cost),
        "totalProfit": str(total_pnl),
        "totalProfitRate": str(total_rate),
        "securityCount": len(items),
    }
    return {"items": items, "aggregate": aggregate}


# ── XIRR §4.2.19 ──
router_xirr = APIRouter(
    prefix="/api/portfolios", tags=["xirr"], route_class=EnvelopeRoute
)


@router_xirr.get("/{portfolio_id}/xirr", response_model=list[XirrPointOut])
async def get_xirr_series(
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    granularity: str = "day",
    startDate: Optional[date] = None,
    endDate: Optional[date] = None,
    aggregation: str = "last",
):
    stmt = select(DailyXirr).where(DailyXirr.portfolio_id == p.id)
    if startDate:
        stmt = stmt.where(DailyXirr.date >= startDate)
    if endDate:
        stmt = stmt.where(DailyXirr.date <= endDate)
    stmt = stmt.order_by(DailyXirr.date)
    rows = (
        await db.execute(stmt)
    ).scalars().all()
    series = [(r.date, r.xirr_value) for r in rows]
    return _bucket(series, granularity, aggregation)


@router_xirr.get("/{portfolio_id}/xirr/latest", response_model=XirrLatestOut)
async def get_xirr_latest(p=Depends(get_portfolio), db: AsyncSession = Depends(get_db)):
    row = (
        await db.execute(
            select(DailyXirr)
            .where(DailyXirr.portfolio_id == p.id, DailyXirr.xirr_value.is_not(None))
            .order_by(DailyXirr.date.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if row is None:
        return None
    return {"date": row.date, "xirrValue": row.xirr_value}


# ── NAV §4.2.20 ──
router_nav = APIRouter(
    prefix="/api/portfolios", tags=["nav"], route_class=EnvelopeRoute
)


@router_nav.get("/{portfolio_id}/nav", response_model=list[NavPointOut])
async def get_nav_series(
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    granularity: str = "day",
    startDate: Optional[date] = None,
    endDate: Optional[date] = None,
    aggregation: str = "last",
    metric: str = "cumulative",
):
    stmt = select(DailyNav).where(DailyNav.portfolio_id == p.id)
    if startDate:
        stmt = stmt.where(DailyNav.date >= startDate)
    if endDate:
        stmt = stmt.where(DailyNav.date <= endDate)
    stmt = stmt.order_by(DailyNav.date)
    rows = (await db.execute(stmt)).scalars().all()

    # 缺陷5 / 缺陷4-B：单指标也同时返回 cumulativeNav/yearNav（未选中置 null），
    # 避免前端 NavSeriesPoint 解包到 undefined → 曲线不渲染 /「数据不足」。
    # 保留 value 字段（既有后端测试依赖）以兼容历史契约。
    groups: dict = {}
    for r in rows:
        groups.setdefault(_period_key(r.date, granularity), []).append(r)
    out = []
    for key in sorted(groups):
        items = groups[key]
        rep = _bucket_date(min(r.date for r in items), granularity)
        last = items[-1]
        if metric == "year":
            cum = None
            yr = _agg([r.year_nav for r in items], aggregation)
            value = yr
        elif metric == "both":
            cum = last.cumulative_nav
            yr = last.year_nav
            value = None
        else:  # cumulative（含缺省）
            cum = _agg([r.cumulative_nav for r in items], aggregation)
            yr = None
            value = cum
        out.append(
            {
                "date": rep,
                "value": value,
                "cumulativeNav": cum,
                "yearNav": yr,
                "shares": _agg([r.shares for r in items], aggregation),
            }
        )
    return out


@router_nav.get("/{portfolio_id}/nav/latest", response_model=NavPointOut)
async def get_nav_latest(p=Depends(get_portfolio), db: AsyncSession = Depends(get_db)):
    row = (
        await db.execute(
            select(DailyNav)
            .where(DailyNav.portfolio_id == p.id)
            .order_by(DailyNav.date.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if row is None:
        return None
    return {
        "date": row.date,
        "cumulativeNav": row.cumulative_nav,
        "yearNav": row.year_nav,
        "shares": row.shares,
    }


# ── 重算 §4.2.21 ──
router_recalculate = APIRouter(
    prefix="/api/portfolios", tags=["recalculate"], route_class=EnvelopeRoute
)


@router_recalculate.post("/{portfolio_id}/recalculate-range", response_model=RecalcOut)
async def recalculate_range(
    req: RecalculateRangeReq,
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
):
    start = req.startDate or await _first_event_date(db, p.id)
    if start is None:
        return {"affectedDates": 0, "duration": 0}
    end = req.endDate
    t0 = time.perf_counter()
    n = (await RecalculationService(db).recalculateRange(p.id, start, end)).affected_days
    duration = int((time.perf_counter() - t0) * 1000)
    return {"affectedDates": n, "duration": duration}


@router_recalculate.post("/{portfolio_id}/recalculate", response_model=RecalcOut)
async def recalculate_full(p=Depends(get_portfolio), db: AsyncSession = Depends(get_db)):
    start = await _first_event_date(db, p.id)
    if start is None:
        return {"affectedDates": 0, "duration": 0}
    t0 = time.perf_counter()
    n = (await RecalculationService(db).recalculateRange(p.id, start)).affected_days
    duration = int((time.perf_counter() - t0) * 1000)
    return {"affectedDates": n, "duration": duration}


# ── NAV / XIRR 历史（带分页）§4.2.19 / §4.2.20 ──
@router_nav.get("/{portfolio_id}/nav/history", response_model=Paginated[NavPointOut])
async def get_nav_history(
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    granularity: str = "month",
    aggregation: str = "last",
    startDate: Optional[date] = None,
    endDate: Optional[date] = None,
    page: int = 1,
    pageSize: int = 20,
):
    rows = await _load_nav_rows(db, p.id, startDate, endDate)
    points = _bucket_nav(rows, granularity, aggregation)
    total = len(points)
    items = points[(page - 1) * pageSize : page * pageSize]
    return {"items": items, "total": total, "page": page, "pageSize": pageSize}


@router_xirr.get("/{portfolio_id}/xirr/history", response_model=Paginated[XirrPointOut])
async def get_xirr_history(
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    granularity: str = "month",
    aggregation: str = "last",
    startDate: Optional[date] = None,
    endDate: Optional[date] = None,
    page: int = 1,
    pageSize: int = 20,
):
    rows = await _load_xirr_rows(db, p.id, startDate, endDate)
    points = _bucket_xirr(rows, granularity, aggregation)
    total = len(points)
    items = points[(page - 1) * pageSize : page * pageSize]
    return {"items": items, "total": total, "page": page, "pageSize": pageSize}


__all__ = [
    "router_holdings",
    "router_xirr",
    "router_nav",
    "router_recalculate",
    "_period_key",
    "_bucket_date",
    "_bucket",
    "_first_event_date",
    "_today",
    "_split_ids",
    "_agg",
    "_bucket_nav",
    "_bucket_xirr",
    "_load_nav_rows",
    "_load_xirr_rows",
]
