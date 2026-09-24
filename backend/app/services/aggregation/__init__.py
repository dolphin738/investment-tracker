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

本模块为门面包：基础读取 / 序列与 XIRR / 摘要与账户统计方法已分别位移至
``._reads`` / ``._series`` / ``._summary`` 三个 mixin，主类继承后所有 ``self._x`` 调用经 MRO
解析，行为零变化；仅重导出 ``AggregationService``（零行为变更）。
"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from typing import Optional

from sqlalchemy import select

from app.core.date_utils import today_app_tz
from app.finance_core.holding import ZERO
from app.models import DailyNav, Portfolio
from app.services.holding import HoldingService

from ._reads import BaseReadsMixin
from ._series import SeriesMixin
from ._summary import SummaryMixin


class AggregationService(BaseReadsMixin, SeriesMixin, SummaryMixin):
    def __init__(self, session) -> None:
        self.session = session

    # ── §4.2.10 组合概览 ──
    async def overview(self, p: Portfolio, range: str = "1y") -> dict:
        today = today_app_tz()
        snap = await self._latest_snapshot(p.id)
        xirr = await self._latest_xirr(p.id)
        cumulative_xirr = xirr.xirr_value if xirr else None

        # 持仓汇总（缺陷4-A）：当前持仓市值/成本/盈亏/标的数
        holdings = await HoldingService(self.session).derive(
            p.id, today, include_closed=False
        )
        total_mv = sum((h.market_value for h in holdings), ZERO)
        total_cost = sum((h.cost_total for h in holdings), ZERO)
        total_pnl = total_mv - total_cost
        sec_count = sum(1 for h in holdings if h.quantity != ZERO)
        holdings_summary = {
            "totalMarketValue": str(total_mv),
            "totalCost": str(total_cost),
            "totalProfit": str(total_pnl),
            "securityCount": sec_count,
        }

        # 当年 XIRR：本年窗口（年初→今天）
        year_start = date(today.year, 1, 1)
        year_xirr = await self._xirr_scope([p.id], year_start, today)

        start = _range_start(range, today)
        nav_series = await self._nav_series(p.id, start, today)
        recent = await self._recent_cashflows(p.id, 10)
        fresh = await self.freshness(p, p.user_id)

        # 净投入 = Σ存入 − Σ取出（概览 8 卡之「净投入」；summary_list 已算，此处补齐）
        net_invested = (await self._net_invested_by_portfolio([p.id])).get(
            p.id, Decimal(0)
        )

        return {
            "totalAsset": snap.total_asset if snap else None,
            "cumulativeXirr": cumulative_xirr,
            "yearXirr": year_xirr,
            # 净值口径对齐：概览页「净投入」卡的原始值（金额类，必填；无出入金为 '0'）
            "netInvested": str(net_invested),
            "holdingsSummary": holdings_summary,
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


__all__ = ["AggregationService", "_range_start"]
