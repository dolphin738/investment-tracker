"""AggregationService 的净值序列 / 近期出入金 / 窗口 XIRR 方法（mixin）。

原函数体从 ``aggregation`` 主类位移至此；主类继承后所有 ``self._x`` 调用经 MRO 解析，
行为零变化。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Iterable, Optional

from sqlalchemy import select

from app.finance_core.xirr import Cashflow, calculate_xirr
from app.models import AssetSnapshot, CashFlow, CashFlowType, DailyNav
from app.serializers import serialize_cashflow


class SeriesMixin:
    # ── 内部：净值序列片段 ──
    async def _nav_series(
        self, portfolio_id: str, start: Optional[date], end: date
    ) -> list[dict]:
        stmt = select(DailyNav).where(DailyNav.portfolio_id == portfolio_id)
        if start:
            stmt = stmt.where(DailyNav.date >= start)
        stmt = stmt.where(DailyNav.date <= end).order_by(DailyNav.date)
        rows = (await self.session.execute(stmt)).scalars().all()
        rows = rows[-500:]  # 避免全量过长
        return [
            {
                "date": r.date,
                "cumulativeNav": r.cumulative_nav,
                "yearNav": r.year_nav,
                "shares": r.shares,
                "label": r.date.isoformat(),
            }
            for r in rows
        ]

    async def _recent_cashflows(self, portfolio_id: str, n: int) -> list[dict]:
        rows = (
            await self.session.execute(
                select(CashFlow)
                .where(CashFlow.portfolio_id == portfolio_id)
                .order_by(CashFlow.date.desc(), CashFlow.created_at.desc())
                .limit(n)
            )
        ).scalars().all()
        return [serialize_cashflow(c).model_dump() for c in reversed(rows)]

    # ── 内部：窗口/账户级 XIRR ──
    async def _xirr_scope(
        self, portfolio_ids: Iterable[str], start: date, end: date
    ) -> Optional[Decimal]:
        pids = list(portfolio_ids)
        if not pids:
            return None
        cfs: list[Cashflow] = []
        # 窗口内出入金（BUY 负 / SELL 正）
        rows = (
            await self.session.execute(
                select(CashFlow).where(
                    CashFlow.portfolio_id.in_(pids),
                    CashFlow.date >= start,
                    CashFlow.date <= end,
                )
            )
        ).scalars().all()
        for cf in rows:
            amt = -cf.amount if cf.type is CashFlowType.BUY else cf.amount
            cfs.append(Cashflow(cf.date, amt))
        # 期初持仓（窗口起点视为买入投资，负值）
        for pid in pids:
            opening = (
                await self.session.execute(
                    select(AssetSnapshot)
                    .where(AssetSnapshot.portfolio_id == pid, AssetSnapshot.date < start)
                    .order_by(AssetSnapshot.date.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()
            if opening:
                cfs.append(Cashflow(start, -opening.total_asset))
        # 期末资产（正终值）
        for pid in pids:
            term = (
                await self.session.execute(
                    select(AssetSnapshot)
                    .where(AssetSnapshot.portfolio_id == pid, AssetSnapshot.date <= end)
                    .order_by(AssetSnapshot.date.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()
            if term:
                cfs.append(Cashflow(term.date, term.total_asset))
        return calculate_xirr(cfs)
