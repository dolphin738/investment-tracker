"""Phase 2 计算服务集成测试：真实 PostgreSQL 种子数据跑 compute_range + derive。

对真实库自清理（末尾级联删除测试用户），不污染数据。
口径对齐 docs/ARCHITECTURE.md §7 / §9。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select, text

import app.db.database as dbmod
import app.models  # noqa: F401
from app.finance_core import HoldingView
from app.models import (
    AssetSnapshot,
    CashFlow,
    CashFlowType,
    DailyNav,
    DailyXirr,
    Portfolio,
    PortfolioSecurity,
    Security,
    SecurityPrice,
    SecuritySide,
    SecurityTrade,
    SecurityType,
    SnapshotSource,
    SnapshotValuation,
    User,
)
from app.services.calculation import CalculationService
from app.services.holding import HoldingService

MARKER = "phase2_svc_test@example.com"


@pytest.mark.asyncio
async def test_compute_range_nav_and_xirr():
    async with dbmod.AsyncSessionLocal() as s:
        await s.execute(text("DELETE FROM users WHERE email = :e"), {"e": MARKER})
        await s.commit()

        u = User(email=MARKER, password_hash="x", name="t")
        s.add(u)
        await s.flush()
        p = Portfolio(user_id=u.id, name="P2")
        s.add(p)
        await s.flush()

        # 出入金：成立日买入 1000
        s.add(CashFlow(portfolio_id=p.id, date=date(2026, 1, 2), type=CashFlowType.BUY, amount=Decimal("1000")))

        # 资产快照（含跨年，验证当年净值重置）
        snaps = [
            (date(2026, 1, 2), Decimal("1000")),
            (date(2026, 7, 2), Decimal("1100")),
            (date(2026, 12, 31), Decimal("1210")),
            (date(2027, 7, 2), Decimal("1300")),
        ]
        for d, total in snaps:
            s.add(
                AssetSnapshot(
                    portfolio_id=p.id,
                    date=d,
                    total_asset=total,
                    source=SnapshotSource.DERIVED,
                    valuation_flag=SnapshotValuation.EXACT,
                )
            )
        await s.commit()

        calc = CalculationService(s)
        n = await calc.compute_range(p.id, date(2026, 1, 1), date(2027, 12, 31))
        assert n == 4

        navs = (
            await s.execute(select(DailyNav).where(DailyNav.portfolio_id == p.id).order_by(DailyNav.date))
        ).scalars().all()
        assert len(navs) == 4
        # 成立日
        assert navs[0].unit_nav == Decimal("1.000000")
        assert navs[0].shares == Decimal("1000.000000")
        assert navs[0].year_nav == Decimal("1.000000")
        # 半年（净值 1.1）
        assert navs[1].unit_nav == Decimal("1.100000")
        assert navs[1].year_nav == Decimal("1.100000")
        # 年末（净值 1.21）
        assert navs[2].unit_nav == Decimal("1.210000")
        assert navs[2].year_nav == Decimal("1.210000")
        # 跨年（2027）：当年净值重置 1.0，base=上年末 1.21
        assert navs[3].date == date(2027, 7, 2)
        assert navs[3].unit_nav == Decimal("1.300000")
        assert navs[3].year_nav == Decimal("1.000000")
        assert navs[3].base_cumulative_nav == Decimal("1.210000")

        xirrs = (
            await s.execute(select(DailyXirr).where(DailyXirr.portfolio_id == p.id).order_by(DailyXirr.date))
        ).scalars().all()
        assert len(xirrs) == 4
        # 成立日：两笔同日期等量反向现金流（买入1000 + 当日资产1000）→ NPV 恒 0，XIRR=0（pyxirr 口径：当日无收益）
        assert xirrs[0].xirr_value == Decimal("0.00000000")
        # 半年：约 21%
        assert xirrs[1].xirr_value is not None
        assert abs(xirrs[1].xirr_value - Decimal("0.21")) < Decimal("0.01")
        # 年末：约 21%
        assert xirrs[2].xirr_value is not None
        assert abs(xirrs[2].xirr_value - Decimal("0.21")) < Decimal("0.01")

        # 清理（级联删组合及其全部派生数据）
        await s.delete(u)
        await s.commit()


@pytest.mark.asyncio
async def test_holding_derive_and_filters():
    async with dbmod.AsyncSessionLocal() as s:
        await s.execute(text("DELETE FROM users WHERE email = :e"), {"e": MARKER})
        await s.commit()

        u = User(email=MARKER, password_hash="x", name="t")
        s.add(u)
        await s.flush()
        p = Portfolio(user_id=u.id, name="P2")
        s.add(p)
        await s.flush()
        master = Security(code="S1", name="S1", asset_class=SecurityType.STOCK)
        s.add(master)
        await s.flush()
        sec = PortfolioSecurity(
            portfolio_id=p.id, master_id=master.id, type=SecurityType.STOCK
        )
        s.add(sec)
        await s.flush()

        trades = [
            SecurityTrade(portfolio_id=p.id, security_id=sec.id, date=date(2026, 1, 2), side=SecuritySide.BUY_SEC, quantity=Decimal("100"), cost_price=Decimal("10.05"), fee_total=Decimal("5")),
            SecurityTrade(portfolio_id=p.id, security_id=sec.id, date=date(2026, 1, 3), side=SecuritySide.BUY_SEC, quantity=Decimal("100"), cost_price=Decimal("12"), fee_total=Decimal("0")),
            SecurityTrade(portfolio_id=p.id, security_id=sec.id, date=date(2026, 1, 4), side=SecuritySide.SELL_SEC, quantity=Decimal("50"), cost_price=Decimal("15"), fee_total=Decimal("0")),
        ]
        s.add_all(trades)
        s.add(SecurityPrice(portfolio_id=p.id, security_id=sec.id, price=Decimal("14"), as_of=date(2026, 1, 4)))
        await s.commit()

        hs = HoldingService(s)
        # as_of 含现价 → 估值 14
        views = await hs.derive(p.id, date(2026, 1, 4))
        assert len(views) == 1
        v: HoldingView = views[0]
        assert v.quantity == Decimal("150")
        assert v.avg_cost == Decimal("11.025")
        assert v.cost_total == Decimal("1653.75")
        assert v.price == Decimal("14")
        assert v.market_value == Decimal("2100")
        assert v.is_cost_based is False

        # as_of 早于现价记录 → 回退 avg_cost 估值
        views2 = await hs.derive(p.id, date(2026, 1, 3))
        assert len(views2) == 1
        assert views2[0].is_cost_based is True
        assert views2[0].price == Decimal("11.025")  # 当日 avg_cost（100*10+5+100*12)/200
        assert views2[0].market_value == Decimal("2205.00")

        # 清仓后再查：默认隐藏已清仓，include_closed 显示
        s.add(SecurityTrade(portfolio_id=p.id, security_id=sec.id, date=date(2026, 1, 5), side=SecuritySide.SELL_SEC, quantity=Decimal("150"), cost_price=Decimal("15"), fee_total=Decimal("0")))
        await s.commit()
        hidden = await hs.derive(p.id, date(2026, 1, 5))
        assert hidden == []  # 默认隐藏 qty=0
        shown = await hs.derive(p.id, date(2026, 1, 5), include_closed=True)
        assert len(shown) == 1
        assert shown[0].quantity == Decimal("0")

        # 单标的过滤
        single = await hs.derive(p.id, date(2026, 1, 4), security_id=sec.id)
        assert len(single) == 1

        await s.delete(u)
        await s.commit()
