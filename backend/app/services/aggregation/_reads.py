"""AggregationService 的基础读取与跨组合批量读取方法（mixin）。

原函数体从 ``aggregation`` 主类位移至此；主类继承后所有 ``self._x`` 调用经 MRO 解析，
行为零变化。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Optional

from sqlalchemy import case, func, select, tuple_

from app.models import (
    AssetSnapshot,
    CashFlow,
    CashFlowType,
    DailyNav,
    DailyXirr,
    SecurityTrade,
)


class BaseReadsMixin:
    # ── 基础读取 ──
    async def _latest_snapshot(self, portfolio_id: str) -> Optional[AssetSnapshot]:
        return (
            await self.session.execute(
                select(AssetSnapshot)
                .where(AssetSnapshot.portfolio_id == portfolio_id)
                .order_by(AssetSnapshot.date.desc())
                .limit(1)
            )
        ).scalar_one_or_none()

    async def _latest_nav(self, portfolio_id: str) -> Optional[DailyNav]:
        return (
            await self.session.execute(
                select(DailyNav)
                .where(DailyNav.portfolio_id == portfolio_id)
                .order_by(DailyNav.date.desc())
                .limit(1)
            )
        ).scalar_one_or_none()

    async def _latest_xirr(self, portfolio_id: str) -> Optional[DailyXirr]:
        return (
            await self.session.execute(
                select(DailyXirr)
                .where(
                    DailyXirr.portfolio_id == portfolio_id,
                    DailyXirr.xirr_value.is_not(None),
                )
                .order_by(DailyXirr.date.desc())
                .limit(1)
            )
        ).scalar_one_or_none()

    # ── 跨组合批量读取（N+1 规避：全部组合常数次查询）──
    async def _latest_by_portfolio(
        self,
        model,
        date_col,
        pids: list[str],
        extra_filter=None,
    ) -> dict[str, object]:
        """每个组合取 date_col 最新一行，返回 {portfolio_id: row}。

        两步查询（group-by max + tuple IN 回表），与组合数无关。
        """
        q = (
            select(model.portfolio_id, func.max(date_col).label("max_date"))
            .where(model.portfolio_id.in_(pids))
            .group_by(model.portfolio_id)
        )
        if extra_filter is not None:
            q = q.where(extra_filter)
        latest = (await self.session.execute(q)).all()
        if not latest:
            return {}
        rows = (
            await self.session.execute(
                select(model).where(
                    tuple_(model.portfolio_id, date_col).in_(
                        [(pid, md) for pid, md in latest]
                    )
                )
            )
        ).scalars().all()
        return {r.portfolio_id: r for r in rows}

    async def _net_invested_by_portfolio(self, pids: list[str]) -> dict[str, Decimal]:
        """净投入 = Σ存入 − Σ取出，SQL 聚合一次覆盖全部组合（无出入金为 0）。"""
        rows = (
            await self.session.execute(
                select(
                    CashFlow.portfolio_id,
                    func.sum(
                        case(
                            (CashFlow.type == CashFlowType.BUY, CashFlow.amount),
                            else_=-CashFlow.amount,
                        )
                    ),
                )
                .where(CashFlow.portfolio_id.in_(pids))
                .group_by(CashFlow.portfolio_id)
            )
        ).all()
        return {pid: (s if s is not None else Decimal(0)) for pid, s in rows}

    async def _last_trade_date_by_portfolio(
        self, pids: list[str]
    ) -> dict[str, Optional[date]]:
        rows = (
            await self.session.execute(
                select(
                    SecurityTrade.portfolio_id, func.max(SecurityTrade.date)
                )
                .where(SecurityTrade.portfolio_id.in_(pids))
                .group_by(SecurityTrade.portfolio_id)
            )
        ).all()
        return {pid: d for pid, d in rows}
