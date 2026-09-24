"""数据导入导出 —— 导出 7 类（CSV / XLSX）与模板。"""

from __future__ import annotations

import csv
import io

from openpyxl import Workbook
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.enums import BusinessErrorCode
from app.core.exceptions import BusinessException
from app.models import (
    AssetSnapshot,
    CashBalance,
    CashFlow,
    DailyNav,
    DailyXirr,
    PortfolioSecurity,
    SecurityPrice,
    SecurityTrade,
)
from app.services.security import compute_type

__all__ = ["build_export", "example_row", "to_csv", "to_xlsx", "safe_name"]


async def build_export(
    type_: str, db: AsyncSession, portfolio_id: str
) -> tuple[list[str], list[list[str]]]:
    if type_ == "securities":
        secs = (
            await db.execute(
                select(PortfolioSecurity)
                .where(PortfolioSecurity.portfolio_id == portfolio_id)
                .options(selectinload(PortfolioSecurity.master))
            )
        ).scalars().all()
        cols = ["code", "name", "type", "currency"]
        rows = [
            [
                s.master.code if s.master else "",
                s.master.name or "" if s.master else "",
                compute_type(s).value,
                s.currency,
            ]
            for s in secs
        ]
        return cols, rows
    if type_ == "securityTrades":
        trades = (
            await db.execute(
                select(SecurityTrade)
                .where(SecurityTrade.portfolio_id == portfolio_id)
                .order_by(SecurityTrade.date, SecurityTrade.created_at)
            )
        ).scalars().all()
        secs = (
            await db.execute(
                select(PortfolioSecurity)
                .where(PortfolioSecurity.portfolio_id == portfolio_id)
                .options(selectinload(PortfolioSecurity.master))
            )
        ).scalars().all()
        code_map = {s.id: (s.master.code if s.master else "") for s in secs}
        cols = ["date", "securityCode", "side", "quantity", "costPrice", "feeTotal", "note"]
        rows = [
            [
                t.date.isoformat(),
                code_map.get(t.security_id, ""),
                t.side.value,
                str(t.quantity),
                str(t.cost_price),
                str(t.fee_total),
                t.note or "",
            ]
            for t in trades
        ]
        return cols, rows
    if type_ == "cashFlows":
        cfs = (
            await db.execute(
                select(CashFlow)
                .where(CashFlow.portfolio_id == portfolio_id)
                .order_by(CashFlow.date, CashFlow.created_at)
            )
        ).scalars().all()
        cols = ["date", "type", "amount", "note"]
        rows = [[c.date.isoformat(), c.type.value, str(c.amount), c.note or ""] for c in cfs]
        return cols, rows
    if type_ == "cashBalances":
        cbs = (
            await db.execute(
                select(CashBalance)
                .where(CashBalance.portfolio_id == portfolio_id)
                .order_by(CashBalance.as_of)
            )
        ).scalars().all()
        cols = ["asOf", "amount", "note"]
        rows = [[c.as_of.isoformat(), str(c.amount), c.note or ""] for c in cbs]
        return cols, rows
    if type_ == "securityPrices":
        ps = (
            await db.execute(
                select(SecurityPrice)
                .where(SecurityPrice.portfolio_id == portfolio_id)
                .order_by(SecurityPrice.as_of)
            )
        ).scalars().all()
        secs = (
            await db.execute(
                select(PortfolioSecurity)
                .where(PortfolioSecurity.portfolio_id == portfolio_id)
                .options(selectinload(PortfolioSecurity.master))
            )
        ).scalars().all()
        code_map = {s.id: (s.master.code if s.master else "") for s in secs}
        cols = ["asOf", "securityCode", "price"]
        rows = [[p.as_of.isoformat(), code_map.get(p.security_id, ""), str(p.price)] for p in ps]
        return cols, rows
    if type_ == "assetSnapshots":
        snaps = (
            await db.execute(
                select(AssetSnapshot)
                .where(AssetSnapshot.portfolio_id == portfolio_id)
                .order_by(AssetSnapshot.date)
            )
        ).scalars().all()
        cols = ["date", "totalAsset", "marketValue", "cashBalance", "source", "note"]
        rows = [
            [
                s.date.isoformat(),
                str(s.total_asset),
                str(s.market_value) if s.market_value is not None else "",
                str(s.cash_balance) if s.cash_balance is not None else "",
                s.source.value,
                s.note or "",
            ]
            for s in snaps
        ]
        return cols, rows
    if type_ == "navSeries":
        navs = (
            await db.execute(
                select(DailyNav)
                .where(DailyNav.portfolio_id == portfolio_id)
                .order_by(DailyNav.date)
            )
        ).scalars().all()
        xirrs = (
            await db.execute(select(DailyXirr).where(DailyXirr.portfolio_id == portfolio_id))
        ).scalars().all()
        snaps = (
            await db.execute(
                select(AssetSnapshot).where(AssetSnapshot.portfolio_id == portfolio_id)
            )
        ).scalars().all()
        xirr_map = {x.date: x.xirr_value for x in xirrs}
        snap_map = {s.date: s.total_asset for s in snaps}
        cols = ["date", "cumulativeNav", "yearlyNav", "shares", "totalAsset", "xirr"]
        rows = []
        for n in navs:
            xv = xirr_map.get(n.date)
            rows.append(
                [
                    n.date.isoformat(),
                    str(n.cumulative_nav),
                    str(n.year_nav),
                    str(n.shares),
                    str(snap_map[n.date]) if n.date in snap_map else "",
                    str(xv) if xv is not None else "",
                ]
            )
        return cols, rows
    raise BusinessException(
        code=BusinessErrorCode.VALIDATION_FAILED,
        message=f"未知导出类型：{type_}",
        status_code=400,
    )


def example_row(type_: str) -> list[str]:
    if type_ == "securityTrades":
        return ["2024-01-01", "600000", "BUY_SEC", "100", "10.50", "0", ""]
    if type_ == "cashFlows":
        return ["2024-01-01", "BUY", "100000.00", ""]
    if type_ == "assetSnapshots":
        return ["2024-01-01", "100000.00", "10000.00", "90000.00", ""]
    return []


def to_csv(columns: list[str], rows: list[list[str]], comment: str) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(columns)
    w.writerow(["# " + comment])
    for r in rows:
        w.writerow(r)
    return ("\ufeff" + buf.getvalue()).encode("utf-8")


def to_xlsx(columns: list[str], rows: list[list[str]]) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.append(columns)
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def safe_name(name: str) -> str:
    import re

    return re.sub(r"[^A-Za-z0-9_\-]", "_", name or "portfolio")[:40]
