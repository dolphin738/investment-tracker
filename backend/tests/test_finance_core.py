"""Phase 2 finance_core 纯函数单测（零 DB 依赖）。

覆盖：XIRR 已知案例 + 边界；净值 成立日/非成立日/跨年重置；持仓 多次买入均价/部分卖出/清仓/卖出硬校验。
口径对齐 docs/ARCHITECTURE.md §7 / §9。
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from app.finance_core import (
    Cashflow,
    HoldingView,
    NavState,
    TradeInput,
    calculate_xirr,
    compute_daily_nav,
    derive_holdings,
    validate_trades_no_negative,
)
from app.models.enums import SecuritySide


# ───────────────────────── XIRR ─────────────────────────
def test_xirr_one_year_known():
    # -1000 一年后得到 +1100 → 恰好 10%（用非闰年 2021→2022，正好 365 天）
    cf = [Cashflow(date(2021, 1, 1), Decimal("-1000")), Cashflow(date(2022, 1, 1), Decimal("1100"))]
    assert calculate_xirr(cf) is not None
    assert abs(calculate_xirr(cf) - Decimal("0.1")) < Decimal("1e-6")


def test_xirr_half_year_known():
    # -1000 半年后 +1100 → (1+r)^0.5 = 1.1 → r≈0.21
    cf = [Cashflow(date(2020, 1, 1), Decimal("-1000")), Cashflow(date(2020, 7, 1), Decimal("1100"))]
    r = calculate_xirr(cf)
    assert r is not None
    assert abs(r - Decimal("0.21")) < Decimal("0.01")


def test_xirr_less_than_two_returns_none():
    assert calculate_xirr([Cashflow(date(2020, 1, 1), Decimal("-1000"))]) is None


def test_xirr_all_positive_returns_none():
    cf = [Cashflow(date(2020, 1, 1), Decimal("100")), Cashflow(date(2020, 6, 1), Decimal("1100"))]
    assert calculate_xirr(cf) is None


def test_xirr_all_negative_returns_none():
    cf = [Cashflow(date(2020, 1, 1), Decimal("-100")), Cashflow(date(2020, 6, 1), Decimal("-1100"))]
    assert calculate_xirr(cf) is None


# ───────────────────────── NAV ─────────────────────────
def test_nav_inception():
    r = compute_daily_nav(None, Decimal("1000"), Decimal("1000"), Decimal("0"), date(2026, 1, 2))
    assert r.unit_nav == Decimal("1.0")
    assert r.cumulative_nav == Decimal("1.0")
    assert r.year_nav == Decimal("1.0")
    assert r.shares == Decimal("1000")
    assert r.base_cumulative_nav == Decimal("1.0")


def test_nav_inception_no_buy_raises():
    import pytest

    with pytest.raises(ValueError):
        compute_daily_nav(None, Decimal("0"), Decimal("0"), Decimal("0"), date(2026, 1, 2))


def test_nav_non_inception():
    prev = NavState(date(2026, 1, 2), Decimal("1000"), Decimal("1.0"), Decimal("1.0"))
    # 当日资产 1600，买入 500，无卖出
    r = compute_daily_nav(prev, Decimal("1600"), Decimal("500"), Decimal("0"), date(2026, 1, 3))
    assert r.unit_nav == Decimal("1.6")
    assert r.cumulative_nav == Decimal("1.6")
    assert r.shares == Decimal("1312.5")  # 1000 + 500/1.6
    assert r.year_nav == Decimal("1.6")  # 同年，base=1.0


def test_nav_year_reset():
    # 上日在 2026 年末、累计 1.5；当日跨入 2027 → 当年净值重置 1.0，base=1.5
    prev = NavState(date(2026, 12, 31), Decimal("100"), Decimal("1.5"), Decimal("1.5"))
    r = compute_daily_nav(prev, Decimal("200"), Decimal("0"), Decimal("0"), date(2027, 1, 4))
    assert r.unit_nav == Decimal("2.0")  # 200/100
    assert r.cumulative_nav == Decimal("2.0")
    assert r.year_nav == Decimal("1.0")
    assert r.base_cumulative_nav == Decimal("1.5")


# ───────────────────────── 持仓推导 ─────────────────────────
def _trade(sec, d, side, q, p, fee=Decimal("0"), created=datetime(2026, 1, 1, 0, 0, 1)):
    return TradeInput(sec, d, created, side, q, p, fee)


def test_holding_multi_buy_partial_sell():
    trades = [
        _trade("S1", date(2026, 1, 2), SecuritySide.BUY_SEC, Decimal("100"), Decimal("10"), Decimal("5")),
        _trade("S1", date(2026, 1, 3), SecuritySide.BUY_SEC, Decimal("100"), Decimal("12")),
        _trade("S1", date(2026, 1, 4), SecuritySide.SELL_SEC, Decimal("50"), Decimal("15")),
    ]
    # 现价 14
    views = derive_holdings(trades, {"S1": Decimal("14")})
    v = views[0]
    assert v.quantity == Decimal("150")
    assert v.avg_cost == Decimal("11.025")  # (100*10+5 + 100*12)/200
    assert v.cost_total == Decimal("1653.75")  # 150 * 11.025
    assert v.price == Decimal("14")
    assert v.market_value == Decimal("2100")  # 150*14
    assert v.is_cost_based is False


def test_holding_avg_cost_unchanged_after_sell():
    # 卖出后 avg_cost 不变（由上面的 cost_total 等比减少验证）
    trades = [
        _trade("S1", date(2026, 1, 2), SecuritySide.BUY_SEC, Decimal("100"), Decimal("10"), Decimal("5")),
        _trade("S1", date(2026, 1, 4), SecuritySide.SELL_SEC, Decimal("40"), Decimal("15")),
    ]
    v = derive_holdings(trades, {"S1": Decimal("14")})[0]
    assert v.quantity == Decimal("60")
    assert v.avg_cost == Decimal("10.05")  # 不变
    assert v.cost_total == Decimal("603.00")  # 60 * 10.05


def test_holding_cost_based_fallback_when_no_price():
    trades = [
        _trade("S1", date(2026, 1, 2), SecuritySide.BUY_SEC, Decimal("100"), Decimal("10"), Decimal("5")),
    ]
    v = derive_holdings(trades, {})[0]  # 无现价
    assert v.is_cost_based is True
    assert v.price == Decimal("10.05")  # 回退 avg_cost
    assert v.market_value == Decimal("1005.00")


def test_holding_liquidate_then_rebuy():
    trades = [
        _trade("S1", date(2026, 1, 2), SecuritySide.BUY_SEC, Decimal("100"), Decimal("10")),
        _trade("S1", date(2026, 1, 3), SecuritySide.SELL_SEC, Decimal("100"), Decimal("15")),  # 清仓
        _trade("S1", date(2026, 1, 4), SecuritySide.BUY_SEC, Decimal("50"), Decimal("20")),  # 重新起算
    ]
    v = derive_holdings(trades, {"S1": Decimal("20")})[0]
    assert v.quantity == Decimal("50")
    assert v.avg_cost == Decimal("20")  # 清仓后重新买入，avg 重置为 20
    assert v.cost_total == Decimal("1000.00")


def test_validate_no_negative_on_oversell():
    trades = [
        _trade("S1", date(2026, 1, 2), SecuritySide.BUY_SEC, Decimal("100"), Decimal("10")),
        _trade("S1", date(2026, 1, 3), SecuritySide.SELL_SEC, Decimal("150"), Decimal("15")),  # 超卖
    ]
    bad = validate_trades_no_negative(trades)
    assert bad == ["S1"]


def test_validate_no_negative_clean():
    trades = [
        _trade("S1", date(2026, 1, 2), SecuritySide.BUY_SEC, Decimal("100"), Decimal("10")),
        _trade("S1", date(2026, 1, 3), SecuritySide.SELL_SEC, Decimal("100"), Decimal("15")),
    ]
    assert validate_trades_no_negative(trades) == []
