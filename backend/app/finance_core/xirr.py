"""XIRR 计算（基于 pyxirr，浮点实现；口径与精度对齐 pyxirr）。

对齐 docs/ARCHITECTURE.md §7.1 精神（初始 guess=0.1），数值核心委托 pyxirr：
- 日期基准：实际天数 / 365（pyxirr 默认 ACT/365，与旧 Decimal 实现等价）
- 多 IRR：pyxirr 失败兜底取最低解（pyxirr 内部行为，直接采用）
- 边界：现金流<2 或全同号 → 返回 None（pyxirr 抛 InvalidPaymentsError，这里捕获转 None）
- 精度：pyxirr 返回 float（f64），落库量化到 8 位小数（PRD 8.1 NUMERIC(20,8)）
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from math import isfinite

import pyxirr

_XIRR_Q = Decimal("1e-8")  # PRD 8.1: XIRR NUMERIC(20,8)


def _isfinite(x: float) -> bool:
    return isfinite(x)


@dataclass(frozen=True)
class Cashflow:
    """单笔现金流：d=日期，amount=金额（买入负/卖出正/终值正）。"""

    d: date
    amount: Decimal


def calculate_xirr(cashflows: list[Cashflow]) -> Decimal | None:
    """计算年化收益率（小数形式，如 0.1234 = 12.34%）；不可计算返回 None。

    数值核心由 pyxirr 提供（默认 guess=0.1、ACT/365）。
    现金流<2 或全同号（pyxirr 抛 InvalidPaymentsError）→ None。
    退化情形：同日期等量反向现金流 NPV 恒 0 → pyxirr 返回 0.0（即当日无收益）。
    """
    ordered = sorted(cashflows, key=lambda c: c.d)
    if len(ordered) < 2:
        return None
    if all(c.amount > 0 for c in ordered) or all(c.amount < 0 for c in ordered):
        return None

    dates = [c.d for c in ordered]
    amounts = [float(c.amount) for c in ordered]
    try:
        rate = pyxirr.xirr(dates, amounts)
    except pyxirr.InvalidPaymentsError:
        # 全同号 / 无法插值出变号 → 不可计算
        return None
    except Exception:
        # pyxirr 求解失败（如非传统现金流无实解）同样视为不可计算
        return None
    if rate is None:
        return None
    # pyxirr 对退化现金流（如同日收付、无解）可能返回 inf/nan → 视为不可计算
    if not _isfinite(rate):
        return None
    # float(f64) → 8 位小数 Decimal（PRD 8.1 NUMERIC(20,8)）
    try:
        return Decimal(str(rate)).quantize(_XIRR_Q)
    except (InvalidOperation, ValueError):
        return None
