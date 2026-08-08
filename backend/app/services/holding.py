"""持仓推导服务（方案B）：查 SecurityTrade≤as_of + 最新价≤as_of，回放得 HoldingView。

对齐 docs/ARCHITECTURE.md §9：持仓不落库，只读查询。
- 现价 = 该标的 as_of 前最后一条 SecurityPrice（向前沿用）；无则回退 avg_cost（is_cost_based=True）。
- 支持 include_closed（默认隐藏已清仓 qty=0）与 security_id 单标的过滤。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.finance_core.holding import HoldingView, TradeInput, derive_holdings
from app.models import SecurityPrice, SecurityTrade


class HoldingService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def derive(
        self,
        portfolio_id: str,
        as_of: date,
        include_closed: bool = False,
        security_id: str | None = None,
        exclude_trade_id: str | None = None,
    ) -> list[HoldingView]:
        q = select(SecurityTrade).where(
            SecurityTrade.portfolio_id == portfolio_id,
            SecurityTrade.date <= as_of,
        )
        if security_id:
            q = q.where(SecurityTrade.security_id == security_id)
        if exclude_trade_id:
            q = q.where(SecurityTrade.id != exclude_trade_id)
        q = q.order_by(SecurityTrade.date, SecurityTrade.created_at)
        trades = (await self.session.execute(q)).scalars().all()

        inputs = [
            TradeInput(
                security_id=t.security_id,
                date=t.date,
                created_at=t.created_at,
                side=t.side,
                quantity=t.quantity,
                cost_price=t.cost_price,
                fee_total=t.fee_total,
            )
            for t in trades
        ]

        prices = await self._latest_prices(portfolio_id, as_of)
        views = derive_holdings(inputs, prices)
        if not include_closed:
            views = [v for v in views if v.quantity != 0]
        return views

    async def _latest_prices(self, portfolio_id: str, as_of: date) -> dict[str, Decimal | None]:
        rows = (
            await self.session.execute(
                select(SecurityPrice).where(
                    SecurityPrice.portfolio_id == portfolio_id,
                    SecurityPrice.as_of <= as_of,
                )
            )
        ).scalars().all()
        best: dict[str, tuple[date, Decimal]] = {}
        for p in rows:
            cur = best.get(p.security_id)
            if cur is None or p.as_of > cur[0]:
                best[p.security_id] = (p.as_of, p.price)
        return {sid: price for sid, (_, price) in best.items()}
