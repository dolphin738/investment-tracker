"""finance_core — 零依赖纯金融算法库（XIRR / 净值 / 持仓推导）。

backend 计算层依赖它；纯函数、不触碰数据库，可独立单测。
"""
from app.finance_core.holding import (
    HoldingView,
    TradeInput,
    derive_holdings,
    validate_trades_no_negative,
)
from app.finance_core.nav import NavResult, NavState, compute_daily_nav
from app.finance_core.xirr import Cashflow, calculate_xirr

__all__ = [
    "calculate_xirr",
    "Cashflow",
    "compute_daily_nav",
    "NavState",
    "NavResult",
    "TradeInput",
    "HoldingView",
    "derive_holdings",
    "validate_trades_no_negative",
]
