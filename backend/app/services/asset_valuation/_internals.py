"""AssetValuationService 的内部工具方法（mixin）。

原函数体从 ``asset_valuation`` 主类位移至此；主类继承本 mixin 后，所有 ``self._x``
调用经 MRO 解析，行为零变化（对齐 dividend_pending 的 mixin 拆分方案）。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import delete, select

from app.finance_core.holding import ZERO
from app.models import (
    AssetSnapshot,
    CashBalance,
    DailyNav,
    DailyXirr,
    SecurityPrice,
    SecurityTrade,
    SnapshotSource,
    SnapshotValuation,
)


class AssetValuationInternalsMixin:
    async def _get_snapshot(
        self, portfolio_id: str, d: date
    ) -> AssetSnapshot | None:
        return (
            await self.session.execute(
                select(AssetSnapshot).where(
                    AssetSnapshot.portfolio_id == portfolio_id,
                    AssetSnapshot.date == d,
                )
            )
        ).scalar_one_or_none()

    async def _latest_cash_balance(
        self, portfolio_id: str, d: date
    ) -> Decimal | None:
        row = (
            await self.session.execute(
                select(CashBalance)
                .where(
                    CashBalance.portfolio_id == portfolio_id,
                    CashBalance.as_of <= d,
                )
                .order_by(
                    CashBalance.as_of.desc(),
                    CashBalance.created_at.desc(),
                    CashBalance.id.desc(),
                )
                .limit(1)
            )
        ).scalar_one_or_none()
        return row.amount if row is not None else None

    def _valuation_flag(self, holdings: list, cash_exists: bool) -> SnapshotValuation:
        if any(h.is_cost_based for h in holdings if h.quantity != ZERO):
            return SnapshotValuation.COST_BASED
        if cash_exists:
            return SnapshotValuation.EXACT
        return SnapshotValuation.CARRIED_FORWARD

    def _compute_one(
        self,
        d: date,
        held: dict[str, list],
        price_best: dict[str, tuple[date, Decimal]],
        cash_best: dict[date, CashBalance],
    ):
        from app.finance_core.holding import (
            HoldingView,
            TradeInput,
            derive_holdings,
        )
        from app.services.asset_valuation import DerivedResult

        inputs: list[TradeInput] = []
        for sec_id, ts in held.items():
            for t in ts:
                if t.date <= d:
                    inputs.append(
                        TradeInput(
                            security_id=t.security_id,
                            date=t.date,
                            created_at=t.created_at,
                            side=t.side,
                            quantity=t.quantity,
                            cost_price=t.cost_price,
                            fee_total=t.fee_total,
                        )
                    )
        prices: dict[str, Decimal | None] = {}
        for sec_id, (as_of, price) in price_best.items():
            prices[sec_id] = price if as_of <= d else None
        views: list[HoldingView] = derive_holdings(inputs, prices)
        market_value = sum((h.market_value for h in views), ZERO)
        # 取 ≤d 的最后一条现金余额
        cash = ZERO
        cash_exists = False
        for as_of in sorted(cash_best.keys()):
            if as_of <= d:
                cash = cash_best[as_of].amount or ZERO
                cash_exists = True
            else:
                break
        total = market_value + cash
        flag = self._valuation_flag(views, cash_exists)
        return DerivedResult(
            total_asset=total,
            market_value=market_value,
            cash_balance=cash,
            valuation_flag=flag,
        )

    async def _is_event_date(self, portfolio_id: str, d: date) -> bool:
        for tbl, col in (
            (SecurityTrade, SecurityTrade.date),
            (CashBalance, CashBalance.as_of),
            (SecurityPrice, SecurityPrice.as_of),
        ):
            exists = (
                await self.session.execute(
                    select(tbl.id).where(tbl.portfolio_id == portfolio_id, col == d).limit(1)
                )
            ).first()
            if exists is not None:
                return True
        from app.models import CashFlow

        exists = (
            await self.session.execute(
                select(CashFlow.id)
                .where(CashFlow.portfolio_id == portfolio_id, CashFlow.date == d)
                .limit(1)
            )
        ).first()
        return exists is not None

    async def has_any_event_upto(
        self, portfolio_id: str, d: date
    ) -> bool:
        """是否存在任何事件（交易/现金/行情/出入金）日期 ≤ d。

        用于删除手工快照后判断当日是否仍可派生自动记录：只要组合在 d 当日或之前
        有过任何数据，当日就应有 DERIVED 自动快照（由历史数据向前沿用），删除手工
        记录后必须补回，保障 XIRR/净值链不断（修复缺陷5）。与 ``_is_event_date``
        （要求事件恰好落在 d）不同，本方法用 ``<= d`` 放宽到「历史存在即可」。
        """
        for tbl, col in (
            (SecurityTrade, SecurityTrade.date),
            (CashBalance, CashBalance.as_of),
            (SecurityPrice, SecurityPrice.as_of),
        ):
            exists = (
                await self.session.execute(
                    select(tbl.id)
                    .where(tbl.portfolio_id == portfolio_id, col <= d)
                    .limit(1)
                )
            ).first()
            if exists is not None:
                return True
        from app.models import CashFlow

        exists = (
            await self.session.execute(
                select(CashFlow.id)
                .where(CashFlow.portfolio_id == portfolio_id, CashFlow.date <= d)
                .limit(1)
            )
        ).first()
        return exists is not None

    async def _delete_derived_day(self, portfolio_id: str, d: date) -> None:
        """事务内三删：DERIVED 快照 + daily_nav + daily_xirr（避免幽灵 prevNav）。"""
        await self.session.execute(
            delete(AssetSnapshot).where(
                AssetSnapshot.portfolio_id == portfolio_id,
                AssetSnapshot.date == d,
                AssetSnapshot.source == SnapshotSource.DERIVED,
            )
        )
        await self.session.execute(
            delete(DailyNav).where(
                DailyNav.portfolio_id == portfolio_id, DailyNav.date == d
            )
        )
        await self.session.execute(
            delete(DailyXirr).where(
                DailyXirr.portfolio_id == portfolio_id, DailyXirr.date == d
            )
        )
