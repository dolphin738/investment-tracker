"""计算路由的纯函数辅助：时间分桶 / 聚合 / 历史行加载 / 小工具。

这些函数无端点副作用，从 ``router.py`` 位移至此以保持端点原位（openapi 契约零 diff）；
``router.py`` 导入并原样重导出，保证 ``calculation.router._period_key`` 等引用不变。
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    CashBalance,
    CashFlow,
    DailyNav,
    DailyXirr,
    SecurityPrice,
    SecurityTrade,
)


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


def _today() -> date:
    from app.core.date_utils import today_app_tz

    return today_app_tz()


def _split_ids(raw: Optional[str]) -> Optional[list[str]]:
    if not raw:
        return None
    return [x for x in raw.split(",") if x]
