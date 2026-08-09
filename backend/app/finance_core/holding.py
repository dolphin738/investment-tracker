"""持仓推导引擎（方案B · 交易明细法，纯函数）。对齐 docs/ARCHITECTURE.md §9。

持仓不落库，由 SecurityTrade 流水按 (date, created_at) 升序回放推导：
- 买入：cost_total += q*cost_price（cost_price 为含费单价，费用已并入，不再单独加 fee）；qty += q；avg_cost = cost_total / qty（移动加权）
- 卖出：qty -= q；avg_cost 不变；cost_total = qty * avg_cost；qty==0 时归零重置
- 市值 = qty * price（price = 最新 SecurityPrice asOf<=date，无则回退 avg_cost 并标记 is_cost_based）
另含 §9.2 卖出硬校验（回放过程不得出现负持仓）。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal

from app.models.enums import SecuritySide

ZERO = Decimal(0)


@dataclass
class TradeInput:
    security_id: str
    date: date
    created_at: datetime
    side: SecuritySide
    quantity: Decimal
    cost_price: Decimal
    fee_total: Decimal


@dataclass
class HoldingView:
    security_id: str
    quantity: Decimal
    avg_cost: Decimal
    cost_total: Decimal
    price: Decimal | None
    market_value: Decimal
    is_cost_based: bool  # True = 无现价记录，按 avg_cost 估值


def _sort_key(t: TradeInput):
    return (t.date, t.created_at)


def derive_holdings(
    trades: list[TradeInput],
    prices: dict[str, Decimal | None],
) -> list[HoldingView]:
    """回放推导持仓。trades 可跨多标的，按 (date, created_at) 升序逐标的回放。"""
    ordered = sorted(trades, key=_sort_key)
    by_sec: dict[str, list[TradeInput]] = {}
    for t in ordered:
        by_sec.setdefault(t.security_id, []).append(t)

    result: list[HoldingView] = []
    for sec_id, sec_trades in by_sec.items():
        qty = ZERO
        avg_cost = ZERO
        cost_total = ZERO
        for t in sec_trades:
            q = t.quantity
            if t.side is SecuritySide.BUY_SEC:
                cost_total += q * t.cost_price  # cost_price 为含费单价（对齐 app/ INC-03），费用已并入，不再单独加 fee_total
                qty += q
                avg_cost = cost_total / qty if qty != 0 else ZERO
            else:  # SELL_SEC
                qty -= q
                # avg_cost 不变；成本额随数量等比减少
                cost_total = qty * avg_cost
                if qty == 0:
                    avg_cost = ZERO
                    cost_total = ZERO

        price = prices.get(sec_id)
        is_cost_based = price is None
        if price is None:
            price = avg_cost
        market_value = qty * price
        result.append(
            HoldingView(
                security_id=sec_id,
                quantity=qty,
                avg_cost=avg_cost,
                cost_total=cost_total,
                price=price,
                market_value=market_value,
                is_cost_based=is_cost_based,
            )
        )
    return result


def validate_trades_no_negative(trades: list[TradeInput]) -> list[str]:
    """§9.2 卖出硬校验：回放中任一时点 qty<0 的标的 security_id 列表（去重保留首次）。"""
    ordered = sorted(trades, key=_sort_key)
    by_sec: dict[str, list[TradeInput]] = {}
    for t in ordered:
        by_sec.setdefault(t.security_id, []).append(t)

    bad: list[str] = []
    for sec_id, sec_trades in by_sec.items():
        qty = ZERO
        for t in sec_trades:
            if t.side is SecuritySide.SELL_SEC:
                qty -= t.quantity
                if qty < 0 and sec_id not in bad:
                    bad.append(sec_id)
                    break
            else:
                qty += t.quantity
    return bad
