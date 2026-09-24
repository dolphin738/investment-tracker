"""AggregationService 的组合摘要 / 对比 / 账户统计 / 数据新鲜度方法（mixin）。

原函数体从 ``aggregation`` 主类位移至此；主类继承后所有 ``self._x`` 调用经 MRO 解析，
行为零变化。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Optional

from sqlalchemy import func, select

from app.core.date_utils import today_app_tz
from app.models import (
    AssetSnapshot,
    CashBalance,
    CashFlow,
    DailyNav,
    DailyXirr,
    Portfolio,
    SecurityPrice,
    SecurityTrade,
    User,
    UserPreference,
)
from app.services.holding import HoldingService


class SummaryMixin:
    # ── §4.2.14 统计摘要 ──
    async def portfolio_summary(self, p: Portfolio) -> dict:
        snap = await self._latest_snapshot(p.id)
        nav = await self._latest_nav(p.id)
        xirr = await self._latest_xirr(p.id)
        # M3：收益率统一为比值（与 XIRR 一致），前端展示时 ×100
        total_return = (nav.cumulative_nav - Decimal(1)) if nav else None
        year_return = (nav.year_nav - Decimal(1)) if nav else None
        return {
            "cumulativeXirr": xirr.xirr_value if xirr else None,
            "totalReturnRate": total_return,
            "yearReturnRate": year_return,
            "maxDrawdown": None,  # P1，v1 返回 null
            "latestDate": snap.date if snap else None,
            "inceptionDate": p.base_date,
        }

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

    # ── 全部组合摘要行（GET /portfolios/summary · Web 客户端绑定）──
    async def summary_list(self, user_id: str) -> list[dict]:
        """返回 PortfolioSummaryRow 列表，形状与 PortfolioSummaryOut 不同。

        批量化：最新快照/净值/XIRR、净投入、最近买卖日均跨组合一次查询
        （原逐组合约 7 查询 → 与组合数无关的常数级）。
        """
        portfolios = (
            await self.session.execute(
                select(Portfolio)
                .where(Portfolio.user_id == user_id)
                .order_by(Portfolio.created_at.desc())
            )
        ).scalars().all()
        pids = [p.id for p in portfolios]
        if not pids:
            return []

        snaps = await self._latest_by_portfolio(AssetSnapshot, AssetSnapshot.date, pids)
        navs = await self._latest_by_portfolio(DailyNav, DailyNav.date, pids)
        xirrs = await self._latest_by_portfolio(
            DailyXirr,
            DailyXirr.date,
            pids,
            extra_filter=DailyXirr.xirr_value.is_not(None),
        )
        net_invested_map = await self._net_invested_by_portfolio(pids)
        last_trade_map = await self._last_trade_date_by_portfolio(pids)

        out: list[dict] = []
        for p in portfolios:
            snap = snaps.get(p.id)
            nav = navs.get(p.id)
            xirr = xirrs.get(p.id)

            # 净投入 = Σ存入 − Σ取出（SQL 聚合，无出入金为 0）
            net_invested = net_invested_map.get(p.id, Decimal(0))

            # 持仓标的数
            held = await HoldingService(self.session).derive(
                p.id, today_app_tz(), include_closed=False
            )
            holdings_count = sum(1 for h in held if h.quantity > 0)

            # lastUpdatedAt = 快照/买卖较晚者
            last_trade_date = last_trade_map.get(p.id)
            snap_date = snap.date if snap else None
            last_updated = max(
                d for d in [snap_date, last_trade_date] if d is not None
            ) if (snap_date or last_trade_date) else None

            total_asset = snap.total_asset if snap else Decimal(0)
            floating_profit = (
                total_asset - net_invested if snap else None
            )

            cum_nav = nav.cumulative_nav if nav else None
            year_rate = (nav.year_nav - Decimal(1)) if nav else None
            cum_rate = (nav.cumulative_nav - Decimal(1)) if nav else None

            out.append({
                "id": p.id,
                "name": p.name,
                "totalAsset": str(total_asset),
                "holdingsCount": holdings_count,
                "lastUpdatedAt": last_updated.isoformat() if last_updated else None,
                "baseDate": p.base_date.isoformat() if p.base_date else None,
                "currency": p.currency,
                "createdAt": p.created_at.isoformat() if p.created_at else None,
                "cumulativeNav": str(cum_nav) if cum_nav is not None else None,
                "yearReturnRate": str(year_rate) if year_rate is not None else None,
                "cumulativeReturnRate": str(cum_rate) if cum_rate is not None else None,
                "xirr": str(xirr.xirr_value) if xirr and xirr.xirr_value is not None else None,
                "netInvested": str(net_invested),
                "floatingProfit": str(floating_profit) if floating_profit is not None else None,
            })
        return out

    # ── §4.2.16 账户统计 ──
    async def account_stats(self, user_id: str) -> dict:
        """账户页数据统计卡（缺陷6）：对齐前端 AccountStats 契约。

        - portfolioCount：组合数
        - cashflowCount：出入金笔数（CashFlow 计数）
        - tradeCount：证券买卖笔数（SecurityTrade 计数）
        - snapshotDays：总资产记录天数（跨组合去重，distinct 快照日期）
        - recordDays：账户使用天数（注册至今）
        - firstDate / lastDate：快照日期范围起止
        """
        portfolios = (
            await self.session.execute(
                select(Portfolio).where(Portfolio.user_id == user_id)
            )
        ).scalars().all()
        pids = [p.id for p in portfolios]

        cashflow_count = 0
        trade_count = 0
        snapshot_dates: set[date] = set()
        if pids:
            cashflow_count = (
                await self.session.execute(
                    select(func.count())
                    .select_from(CashFlow)
                    .where(CashFlow.portfolio_id.in_(pids))
                )
            ).scalar() or 0
            trade_count = (
                await self.session.execute(
                    select(func.count())
                    .select_from(SecurityTrade)
                    .where(SecurityTrade.portfolio_id.in_(pids))
                )
            ).scalar() or 0
            snap_rows = (
                await self.session.execute(
                    select(AssetSnapshot.date).where(
                        AssetSnapshot.portfolio_id.in_(pids)
                    )
                )
            ).scalars().all()
            snapshot_dates = set(snap_rows)

        # 账户使用天数 = 注册至今（含今天）
        record_days = 0
        user = (
            await self.session.execute(
                select(User).where(User.id == user_id)
            )
        ).scalar_one_or_none()
        if user and user.created_at is not None:
            record_days = (today_app_tz() - user.created_at.date()).days + 1

        snapshot_days = len(snapshot_dates)
        first_date = min(snapshot_dates) if snapshot_dates else None
        last_date = max(snapshot_dates) if snapshot_dates else None
        return {
            "portfolioCount": len(portfolios),
            "cashflowCount": cashflow_count,
            "tradeCount": trade_count,
            "snapshotDays": snapshot_days,
            "recordDays": record_days,
            "firstDate": first_date,
            "lastDate": last_date,
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
            # 任一持仓标的缺失行情记录（无行 / 行数少于持仓数 / 行内 NULL）→ 视为无行情。
            # 必须显式判空：held 非空但 maxes 为空时 min() 会抛 ValueError
            # （未捕获 → 概览页 500「服务器内部错误」）。修复问题3。
            if not maxes or len(maxes) < len(held) or any(
                mx is None for mx in maxes.values()
            ):
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
        # 对齐前端 FreshnessReason（{kind, asOf, lagDays, label}）；此前误将 reasons
        # 返回为纯字符串数组，导致 FreshnessBanner 取不到 r.label（空白内容）与
        # r.kind（无法渲染「去更新行情 / 现金余额」按钮），只剩「本次会话不再提示」。
        reasons: list[dict] = []
        if held and price_asof is None:
            is_stale = True
            reasons.append(
                {
                    "kind": "PRICE",
                    "asOf": None,
                    "lagDays": None,
                    "label": "持仓标的中存在无行情记录",
                }
            )
        elif price_asof and price_lag is not None and price_lag > stale_days:
            is_stale = True
            reasons.append(
                {
                    "kind": "PRICE",
                    "asOf": price_asof,
                    "lagDays": price_lag,
                    "label": f"行情已滞后 {price_lag} 天（阈值 {stale_days} 天）",
                }
            )
        if cash_asof is None:
            is_stale = True
            reasons.append(
                {
                    "kind": "CASH",
                    "asOf": None,
                    "lagDays": None,
                    "label": "无现金余额记录",
                }
            )
        elif cash_lag is not None and cash_lag > stale_days:
            is_stale = True
            reasons.append(
                {
                    "kind": "CASH",
                    "asOf": cash_asof,
                    "lagDays": cash_lag,
                    "label": f"现金余额已滞后 {cash_lag} 天（阈值 {stale_days} 天）",
                }
            )

        return {
            "staleDays": stale_days,
            "isStale": is_stale,
            "latestPriceAsOf": price_asof,
            "latestPriceLagDays": price_lag,
            "latestCashAsOf": cash_asof,
            "latestCashLagDays": cash_lag,
            "reasons": reasons,
        }
