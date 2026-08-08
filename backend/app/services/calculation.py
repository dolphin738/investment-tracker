"""计算引擎编排：快照 → 净值 → XIRR，结果落库 DailyNav / DailyXirr。

对齐 docs/ARCHITECTURE.md §7.3：单日计算是叶子单元，区间由调用方按日期升序逐日驱动
（份额链条具传导性，任意一日资产改写须级联重算至当日）。

口径：
- NAV：成立日首笔买入 shares=买入额、净值=1；非成立日 unit_nav=资产/上日份额；
      跨年首个交易日 year_nav 重置=1、base=上日累计净值。
- XIRR：现金流 = [成立日~当日全部 CashFlow（BUY 负/SELL 正）] + [当日资产快照为正终值]。
- 精度：NAV 量化 6 位、XIRR 量化 8 位（存储精度对齐 PRD 8.1 / E2 决策）。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.finance_core.nav import NavResult, NavState, compute_daily_nav
from app.finance_core.xirr import Cashflow, calculate_xirr
from app.models import AssetSnapshot, CashFlow, CashFlowType, DailyNav, DailyXirr

_NAV_Q = Decimal("0.000001")    # NUMERIC(12,6)
_XIRR_Q = Decimal("0.00000001")  # NUMERIC(20,8)


class CalculationService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def compute_range(self, portfolio_id: str, start: date, end: date) -> int:
        """对 [start, end] 内每个有快照的日期升序计算净值+XIRR 并 upsert。返回处理天数。"""
        snaps = (
            await self.session.execute(
                select(AssetSnapshot)
                .where(
                    AssetSnapshot.portfolio_id == portfolio_id,
                    AssetSnapshot.date >= start,
                    AssetSnapshot.date <= end,
                )
                .order_by(AssetSnapshot.date)
            )
        ).scalars().all()

        # 截至 end 的全部出入金（XIRR 现金流来源，按日筛选）
        all_cf = (
            await self.session.execute(
                select(CashFlow)
                .where(CashFlow.portfolio_id == portfolio_id, CashFlow.date <= end)
                .order_by(CashFlow.date)
            )
        ).scalars().all()

        # 区间内起始前一日净值（延续份额链条）
        prev_row = (
            await self.session.execute(
                select(DailyNav)
                .where(DailyNav.portfolio_id == portfolio_id, DailyNav.date < start)
                .order_by(DailyNav.date.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        prev = (
            NavState(
                date=prev_row.date,
                shares=prev_row.shares,
                cumulative_nav=prev_row.cumulative_nav,
                base_cumulative_nav=prev_row.base_cumulative_nav,
            )
            if prev_row
            else None
        )

        count = 0
        for snap in snaps:
            # NAV 申赎：取【当日】出入金（非累计；架构 §7.2.1 按精确 date）
            day_cf = [c for c in all_cf if c.date == snap.date]
            buy = sum((c.amount for c in day_cf if c.type is CashFlowType.BUY), Decimal(0))
            sell = sum((c.amount for c in day_cf if c.type is CashFlowType.SELL), Decimal(0))

            nav = compute_daily_nav(prev, snap.total_asset, buy, sell, snap.date)
            # 量化后既落库也作为次日递推的 prev（与重跑读库一致）
            nav_q = NavResult(
                unit_nav=nav.unit_nav.quantize(_NAV_Q),
                cumulative_nav=nav.cumulative_nav.quantize(_NAV_Q),
                year_nav=nav.year_nav.quantize(_NAV_Q),
                shares=nav.shares.quantize(_NAV_Q),
                base_cumulative_nav=(
                    nav.base_cumulative_nav.quantize(_NAV_Q)
                    if nav.base_cumulative_nav is not None
                    else None
                ),
            )
            await self._upsert_nav(portfolio_id, snap.date, nav_q)
            prev = NavState(
                date=snap.date,
                shares=nav_q.shares,
                cumulative_nav=nav_q.cumulative_nav,
                base_cumulative_nav=nav_q.base_cumulative_nav,
            )

            # XIRR 现金流：成立日~当日【全部】出入金（BUY 负/SELL 正）+ 当日资产终值
            xirr_cf = [
                Cashflow(c.date, -c.amount if c.type is CashFlowType.BUY else c.amount)
                for c in all_cf
                if c.date <= snap.date
            ]
            xirr_cf.append(Cashflow(snap.date, snap.total_asset))
            xirr = calculate_xirr(xirr_cf)
            xirr_q = xirr.quantize(_XIRR_Q) if xirr is not None else None
            await self._upsert_xirr(portfolio_id, snap.date, xirr_q)
            count += 1

        await self.session.commit()
        return count

    async def _upsert_nav(self, portfolio_id: str, d: date, nav: NavResult) -> None:
        existing = (
            await self.session.execute(
                select(DailyNav).where(DailyNav.portfolio_id == portfolio_id, DailyNav.date == d)
            )
        ).scalar_one_or_none()
        if existing:
            existing.unit_nav = nav.unit_nav
            existing.cumulative_nav = nav.cumulative_nav
            existing.year_nav = nav.year_nav
            existing.shares = nav.shares
            existing.base_cumulative_nav = nav.base_cumulative_nav
        else:
            self.session.add(
                DailyNav(
                    portfolio_id=portfolio_id,
                    date=d,
                    unit_nav=nav.unit_nav,
                    cumulative_nav=nav.cumulative_nav,
                    year_nav=nav.year_nav,
                    shares=nav.shares,
                    base_cumulative_nav=nav.base_cumulative_nav,
                )
            )

    async def _upsert_xirr(self, portfolio_id: str, d: date, xirr: Decimal | None) -> None:
        existing = (
            await self.session.execute(
                select(DailyXirr).where(DailyXirr.portfolio_id == portfolio_id, DailyXirr.date == d)
            )
        ).scalar_one_or_none()
        if existing:
            existing.xirr_value = xirr
        else:
            self.session.add(DailyXirr(portfolio_id=portfolio_id, date=d, xirr_value=xirr))
