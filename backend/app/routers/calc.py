"""计算读取与重算路由 — 对齐 docs/ARCHITECTURE.md §4.2.9~§4.2.15。

- holdings：实时推导（只读，无 CRUD），含 pnl/ratio。
- xirr / nav：时间序列（granularity/aggregation/metric）+ latest。
- recalculate：区间重算 / 全量重算（统一入口）。
"""
from __future__ import annotations

import time
from datetime import date, timedelta
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.envelope import EnvelopeRoute
from app.core.security import CurrentUser, get_current_user
from app.db.database import get_db
from app.finance_core.holding import ZERO
from app.models import (
    CashBalance,
    CashFlow,
    DailyNav,
    DailyXirr,
    Security,
    SecurityPrice,
    SecurityTrade,
)
from app.routers.common import get_portfolio
from app.schemas import RecalculateRangeReq
from app.services.holding import HoldingService
from app.services.recalculation import RecalculationService


def _period_key(d: date, granularity: str):
    if granularity == "week":
        return d.isocalendar()[:2]  # (year, week)
    if granularity == "month":
        return (d.year, d.month)
    if granularity == "year":
        return (d.year,)
    return (d,)  # day


def _bucket_date(d: date, granularity: str) -> date:
    if granularity == "month":
        return d.replace(day=1)
    if granularity == "year":
        return d.replace(month=1, day=1)
    if granularity == "week":
        return d - timedelta(days=d.weekday())
    return d


def _bucket(rows, granularity: str, aggregation: str) -> list[dict]:
    """rows: list[(date, Decimal|None)] → 按粒度分桶，last/avg 聚合。"""
    groups: dict = {}
    for d, v in rows:
        groups.setdefault(_period_key(d, granularity), []).append((d, v))
    out: list[dict] = []
    for key in sorted(groups):
        items = groups[key]
        rep = _bucket_date(min(d for d, _ in items), granularity)
        vals = [v for _, v in items if v is not None]
        if aggregation == "avg" and vals:
            out.append({"date": rep, "value": sum(vals) / len(vals)})
        else:
            out.append({"date": rep, "value": items[-1][1]})
    return out


async def _first_event_date(db: AsyncSession, portfolio_id: str) -> Optional[date]:
    dates: list[date] = []
    for tbl, col in (
        (SecurityTrade, SecurityTrade.date),
        (CashFlow, CashFlow.date),
        (SecurityPrice, SecurityPrice.as_of),
        (CashBalance, CashBalance.as_of),
    ):
        r = (
            await db.execute(
                select(func.min(col)).where(tbl.portfolio_id == portfolio_id)
            )
        ).scalar()
        if r is not None:
            dates.append(r)
    return min(dates) if dates else None


# ── 持仓 §4.2.9 ──
router_holdings = APIRouter(
    prefix="/api/portfolios", tags=["holdings"], route_class=EnvelopeRoute
)


@router_holdings.get("/{portfolio_id}/holdings")
async def get_holdings(
    p=Depends(get_portfolio),
    db: AsyncSession = Depends(get_db),
    asOf: Optional[date] = None,
    securityId: Optional[str] = None,
    includeClosed: bool = False,
):
    as_of = asOf or _today()
    sec_ids = _split_ids(securityId)
    views = await HoldingService(db).derive(
        p.id,
        as_of,
        include_closed=includeClosed,
        security_id=sec_ids[0] if sec_ids and len(sec_ids) == 1 else (sec_ids[0] if sec_ids else None),
    )
    if sec_ids and len(sec_ids) > 1:
        views = [v for v in views if v.security_id in set(sec_ids)]
    sec_map = {
        s.id: s
        for s in (
            await db.execute(select(Security).where(Security.portfolio_id == p.id))
        ).scalars().all()
    }
    out = []
    for v in views:
        pnl = v.market_value - v.cost_total
        ratio = (pnl / v.cost_total) if v.cost_total != ZERO else ZERO
        sec = sec_map.get(v.security_id)
        out.append(
            {
                "securityId": v.security_id,
                "code": sec.code if sec else None,
                "name": sec.name if sec else None,
                "quantity": v.quantity,
                "avgCost": v.avg_cost,
                "costTotal": v.cost_total,
                "price": v.price,
                "marketValue": v.market_value,
                "pnl": pnl,
                "ratio": ratio,
                "isCostBased": v.is_cost_based,
            }
        )
    return out


# ── XIRR §4.2.19 ──
router_xirr = APIRouter(
    prefix="/api/portfolios", tags=["xirr"], route_class=EnvelopeRoute
)


@router_xirr.get("/{portfolio_id}/xirr")
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


@router_xirr.get("/{portfolio_id}/xirr/latest")
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


@router_nav.get("/{portfolio_id}/nav")
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

    def _pick(r: DailyNav) -> Decimal | None:
        if metric == "year":
            return r.year_nav
        if metric == "both":
            return None  # 特殊：下方单独处理
        return r.cumulative_nav

    if metric == "both":
        groups: dict = {}
        for r in rows:
            groups.setdefault(_period_key(r.date, granularity), []).append(r)
        out = []
        for key in sorted(groups):
            items = groups[key]
            rep = _bucket_date(min(r.date for r in items), granularity)
            last = items[-1]
            out.append(
                {
                    "date": rep,
                    "cumulativeNav": last.cumulative_nav,
                    "yearNav": last.year_nav,
                    "shares": last.shares,
                }
            )
        return out

    series = [(r.date, _pick(r)) for r in rows]
    bucketed = _bucket(series, granularity, aggregation)
    return [
        {"date": b["date"], "value": b["value"], "shares": _shares_at(rows, b["date"])}
        for b in bucketed
    ]


def _shares_at(rows, d: date) -> Decimal | None:
    match = [r for r in rows if r.date == d]
    return match[-1].shares if match else None


@router_nav.get("/{portfolio_id}/nav/latest")
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


@router_recalculate.post("/{portfolio_id}/recalculate-range")
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
    n = await RecalculationService(db).recalculateRange(p.id, start, end)
    duration = int((time.perf_counter() - t0) * 1000)
    return {"affectedDates": n, "duration": duration}


@router_recalculate.post("/{portfolio_id}/recalculate")
async def recalculate_full(p=Depends(get_portfolio), db: AsyncSession = Depends(get_db)):
    start = await _first_event_date(db, p.id)
    if start is None:
        return {"affectedDates": 0, "duration": 0}
    t0 = time.perf_counter()
    n = await RecalculationService(db).recalculateRange(p.id, start)
    duration = int((time.perf_counter() - t0) * 1000)
    return {"affectedDates": n, "duration": duration}


def _today() -> date:
    from app.core.date_utils import today_app_tz

    return today_app_tz()


def _split_ids(raw: Optional[str]) -> Optional[list[str]]:
    if not raw:
        return None
    return [x for x in raw.split(",") if x]


# ── NAV / XIRR 历史（带分页）§4.2.19 / §4.2.20 ──
def _agg(vals, aggregation: str):
    clean = [v for v in vals if v is not None]
    if not clean:
        return None
    if aggregation == "avg":
        return sum(clean) / len(clean)
    return clean[-1]


def _bucket_nav(rows, granularity: str, aggregation: str) -> list[dict]:
    groups: dict = {}
    for r in rows:
        groups.setdefault(_period_key(r.date, granularity), []).append(r)
    out: list[dict] = []
    for key in sorted(groups):
        items = groups[key]
        rep = _bucket_date(min(r.date for r in items), granularity)
        out.append(
            {
                "date": rep,
                "cumulativeNav": _agg([r.cumulative_nav for r in items], aggregation),
                "yearNav": _agg([r.year_nav for r in items], aggregation),
                "shares": _agg([r.shares for r in items], aggregation),
            }
        )
    return out


def _bucket_xirr(rows, granularity: str, aggregation: str) -> list[dict]:
    groups: dict = {}
    for r in rows:
        groups.setdefault(_period_key(r.date, granularity), []).append(r)
    out: list[dict] = []
    for key in sorted(groups):
        items = groups[key]
        rep = _bucket_date(min(r.date for r in items), granularity)
        out.append(
            {"date": rep, "xirrValue": _agg([r.xirr_value for r in items], aggregation)}
        )
    return out


async def _load_nav_rows(db, portfolio_id, start, end):
    stmt = select(DailyNav).where(DailyNav.portfolio_id == portfolio_id)
    if start:
        stmt = stmt.where(DailyNav.date >= start)
    if end:
        stmt = stmt.where(DailyNav.date <= end)
    stmt = stmt.order_by(DailyNav.date)
    return (await db.execute(stmt)).scalars().all()


async def _load_xirr_rows(db, portfolio_id, start, end):
    stmt = select(DailyXirr).where(DailyXirr.portfolio_id == portfolio_id)
    if start:
        stmt = stmt.where(DailyXirr.date >= start)
    if end:
        stmt = stmt.where(DailyXirr.date <= end)
    stmt = stmt.order_by(DailyXirr.date)
    return (await db.execute(stmt)).scalars().all()


@router_nav.get("/{portfolio_id}/nav/history")
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


@router_xirr.get("/{portfolio_id}/xirr/history")
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
