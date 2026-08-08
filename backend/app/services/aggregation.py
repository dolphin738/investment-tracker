"""聚合查询服务 — 对齐 docs/ARCHITECTURE.md §4.2.10/§4.2.14/§4.2.15/§4.2.16。

全部为**只读**聚合，复用派生层落库结果（DailyNav / DailyXirr / AssetSnapshot），
不触发任何重算；XIRR 仅对「窗口内现金流 + 期初/期末资产」做一次性 pyxirr 计算。

口径：
- PortfolioSummary：累计XIRR/总收益率/当年收益率 取最新落库值；maxDrawdown v1 恒 null（P1）。
- Overview：总资产=最新快照；累计XIRR=最新落库；当年XIRR=本年窗口 XIRR；
  navSeries=区间净值片段；recentCashflows=最近 N 笔出入金；freshness=数据新鲜度。
- 对比 / 账户统计：跨组合聚合（账户级 XIRR = 组合现金流合并 + 各组合期末资产为终值）。
- freshness：行情维度=持仓标的各自最新价 MAX(as_of) 的最小值（任一持仓标的无行情→null）；
  现金维度=最新现金余额 as_of；滞后天数=as_of→今天(UTC+8)自然日差；超 staleDays 阈值才产出 reasons。
"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from typing import Iterable, Optional

from sqlalchemy import func, select

from app.core.date_utils import today_app_tz
from app.finance_core.xirr import Cashflow, calculate_xirr
from app.models import (
    AssetSnapshot,
    CashBalance,
    CashFlow,
    CashFlowType,
    DailyNav,
    DailyXirr,
    Portfolio,
    SecurityPrice,
    UserPreference,
)
from app.routers.common import serialize_cashflow
from app.services.holding import HoldingService


class AggregationService:
    def __init__(self, session) -> None:
        self.session = session

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

    # ── §4.2.14 统计摘要 ──
    async def portfolio_summary(self, p: Portfolio) -> dict:
        snap = await self._latest_snapshot(p.id)
        nav = await self._latest_nav(p.id)
        xirr = await self._latest_xirr(p.id)
        total_return = (nav.cumulative_nav - Decimal(1)) * Decimal(100) if nav else None
        year_return = (nav.year_nav - Decimal(1)) * Decimal(100) if nav else None
        return {
            "cumulativeXirr": xirr.xirr_value if xirr else None,
            "totalReturnRate": total_return,
            "yearReturnRate": year_return,
            "maxDrawdown": None,  # P1，v1 返回 null
            "latestDate": snap.date if snap else None,
            "inceptionDate": p.base_date,
        }

    # ── §4.2.10 组合概览 ──
    async def overview(self, p: Portfolio, range: str = "1y") -> dict:
        today = today_app_tz()
        snap = await self._latest_snapshot(p.id)
        xirr = await self._latest_xirr(p.id)
        cumulative_xirr = xirr.xirr_value if xirr else None

        # 当年 XIRR：本年窗口（年初→今天）
        year_start = date(today.year, 1, 1)
        year_xirr = await self._xirr_scope([p.id], year_start, today)

        start = _range_start(range, today)
        nav_series = await self._nav_series(p.id, start, today)
        recent = await self._recent_cashflows(p.id, 10)
        fresh = await self.freshness(p, p.user_id)

        return {
            "totalAsset": snap.total_asset if snap else None,
            "cumulativeXirr": cumulative_xirr,
            "yearXirr": year_xirr,
            "navSeries": nav_series,
            "recentCashflows": recent,
            "freshness": fresh,
        }

    # ── §4.2.15 最大回撤时间序列 ──
    async def drawdown(
        self, portfolio_id: str, start: Optional[date], end: Optional[date]
    ) -> list[dict]:
        stmt = select(DailyNav).where(DailyNav.portfolio_id == portfolio_id)
        if start:
            stmt = stmt.where(DailyNav.date >= start)
        if end:
            stmt = stmt.where(DailyNav.date <= end)
        stmt = stmt.order_by(DailyNav.date)
        rows = (await self.session.execute(stmt)).scalars().all()

        out: list[dict] = []
        peak: Optional[Decimal] = None
        peak_date: Optional[date] = None
        for r in rows:
            nav = r.cumulative_nav
            if peak is None or nav > peak:
                peak = nav
                peak_date = r.date
            dd = (nav / peak - Decimal(1)) if (peak and peak > 0) else None
            out.append(
                {
                    "date": r.date,
                    "drawdown": dd,
                    "peakDate": peak_date,
                    "label": r.date.isoformat(),
                }
            )
        return out

    # ── §4.2.10 多组合对比 ──
    async def comparison(self, user_id: str) -> list[dict]:
        portfolios = (
            await self.session.execute(
                select(Portfolio)
                .where(Portfolio.user_id == user_id)
                .order_by(Portfolio.created_at.desc())
            )
        ).scalars().all()
        return [await self.portfolio_summary(p) for p in portfolios]

    # ── §4.2.16 账户统计 ──
    async def account_stats(self, user_id: str) -> dict:
        portfolios = (
            await self.session.execute(
                select(Portfolio).where(Portfolio.user_id == user_id)
            )
        ).scalars().all()
        pids = [p.id for p in portfolios]
        today = today_app_tz()
        total = Decimal(0)
        for pid in pids:
            snap = await self._latest_snapshot(pid)
            if snap:
                total += snap.total_asset
        cumulative = await self._xirr_scope(pids, date(1900, 1, 1), today)
        year_start = date(today.year, 1, 1)
        year = await self._xirr_scope(pids, year_start, today)
        return {
            "portfolioCount": len(portfolios),
            "totalAssets": total,
            "cumulativeXirr": cumulative,
            "yearXirr": year,
        }

    # ── 数据新鲜度（v2.2 · AL-015 / 决策 O-6）──
    async def freshness(self, p: Portfolio, user_id: str) -> dict:
        pref = (
            await self.session.execute(
                select(UserPreference).where(UserPreference.user_id == user_id)
            )
        ).scalar_one_or_none()
        stale_days = pref.stale_days if pref else 3
        today = today_app_tz()

        # 持仓标的（quantity>0）
        held = [
            v.security_id
            for v in await HoldingService(self.session).derive(
                p.id, today, include_closed=False
            )
            if v.quantity > 0
        ]
        price_asof: Optional[date] = None
        price_lag: Optional[int] = None
        if held:
            rows = (
                await self.session.execute(
                    select(SecurityPrice.security_id, func.max(SecurityPrice.as_of))
                    .where(
                        SecurityPrice.portfolio_id == p.id,
                        SecurityPrice.security_id.in_(held),
                    )
                    .group_by(SecurityPrice.security_id)
                )
            ).all()
            maxes = {sid: mx for sid, mx in rows}
            if any(mx is None for mx in maxes.values()):
                price_asof = None  # 存在持仓标的无行情记录
            else:
                price_asof = min(maxes.values())
            if price_asof:
                price_lag = (today - price_asof).days

        cash_row = (
            await self.session.execute(
                select(func.max(CashBalance.as_of)).where(
                    CashBalance.portfolio_id == p.id
                )
            )
        ).scalar()
        cash_asof: Optional[date] = cash_row
        cash_lag: Optional[int] = (today - cash_asof).days if cash_asof else None

        is_stale = False
        reasons: list[str] = []
        if held and price_asof is None:
            is_stale = True
            reasons.append("持仓标的中存在无行情记录")
        elif price_asof and price_lag is not None and price_lag > stale_days:
            is_stale = True
            reasons.append(f"行情已滞后 {price_lag} 天（阈值 {stale_days} 天）")
        if cash_asof is None:
            is_stale = True
            reasons.append("无现金余额记录")
        elif cash_lag is not None and cash_lag > stale_days:
            is_stale = True
            reasons.append(f"现金余额已滞后 {cash_lag} 天（阈值 {stale_days} 天）")

        return {
            "staleDays": stale_days,
            "isStale": is_stale,
            "latestPriceAsOf": price_asof,
            "latestPriceLagDays": price_lag,
            "latestCashAsOf": cash_asof,
            "latestCashLagDays": cash_lag,
            "reasons": reasons,
        }

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
        return [serialize_cashflow(c) for c in reversed(rows)]

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


def _range_start(range: str, today: date) -> Optional[date]:
    """range → 区间起点（含）。all → None（不限）。"""
    delta = {
        "1w": 7,
        "1m": 30,
        "3m": 90,
        "6m": 180,
        "1y": 365,
    }.get(range)
    if range == "ytd":
        return date(today.year, 1, 1)
    if range == "all" or delta is None:
        return None
    return today - timedelta(days=delta)
