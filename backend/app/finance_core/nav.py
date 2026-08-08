"""净值计算（单位份额法，纯函数）。对齐 PRD §3.3/§3.7/附录 B（冻结口径）。

口径（PRD 附录 B 为权威源，ARCH §7.2 若有出入以 PRD 为准）：
- 成立日（无 prev）：首笔必须买入，shares=买入金额，净值=1.0
- 非成立日：unit_nav = (当日资产 − 当日存入 + 当日取出) / 上日份额；cumulative_nav = unit_nav
- 当日申赎：new_shares = (buy - sell) / unit_nav
- 跨年首个交易日：year_nav=1.0，base=上日累计净值（上年末）
- 当年非首日：year_nav = cumulative_nav / base
- 无快照不调用本函数（调用方保证 snapshot 存在）
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal, DivisionByZero, InvalidOperation

ZERO = Decimal(0)


@dataclass
class NavState:
    """上一日净值状态（用于递推）。"""

    date: date
    shares: Decimal
    cumulative_nav: Decimal
    base_cumulative_nav: Decimal | None


@dataclass
class NavResult:
    unit_nav: Decimal
    cumulative_nav: Decimal
    year_nav: Decimal
    shares: Decimal
    base_cumulative_nav: Decimal | None


def compute_daily_nav(
    prev: NavState | None,
    snapshot_total: Decimal,
    day_buy: Decimal,
    day_sell: Decimal,
    current_date: date,
) -> NavResult | None:
    """计算指定日期净值。返回 NavResult；成立日无存入（day_buy<=0）返回 None（组合尚未成立）。

    调用方需处理 None：跳过该日 NAV/XIRR 落库，不推进 prev。
    PRD 的「首笔必须为存入」校验在 API 层（POST /cashflows）执行，计算引擎需对
    临时不完整状态（如导入顺序导致先有快照后有出入金）保持健壮。
    """
    if prev is None:
        # ===== 成立日 =====
        if day_buy <= 0:
            return None  # 组合尚未成立（无存入流水），跳过
        return NavResult(
            unit_nav=Decimal("1.0"),
            cumulative_nav=Decimal("1.0"),
            year_nav=Decimal("1.0"),
            shares=day_buy,
            base_cumulative_nav=Decimal("1.0"),
        )

    # ===== 非成立日 =====
    # PRD 附录 B（冻结）：nav = (assetSnapshot - buyAmount + sellAmount) / shares
    # 期末口径：assetSnapshot 含当日进出，需还原为申赎前资产再计算净值
    nav_numerator = snapshot_total - day_buy + day_sell
    # 防御：上日份额为 0（曾全赎回）或分子为 0，单位净值沿用上日累计净值，避免除零
    if prev.shares == 0 or nav_numerator == 0:
        unit_nav = prev.cumulative_nav
    else:
        unit_nav = nav_numerator / prev.shares
    cumulative_nav = unit_nav

    # 当日申赎：净值=0 时无法增减份额，按 0 处理
    try:
        new_shares = (day_buy - day_sell) / unit_nav if unit_nav != 0 else ZERO
    except (DivisionByZero, InvalidOperation):
        new_shares = ZERO
    shares = prev.shares + new_shares

    if current_date.year != prev.date.year:
        # 跨年首个交易日：重置年度基准
        base_cumulative_nav = prev.cumulative_nav
        year_nav = Decimal("1.0")
    else:
        base_cumulative_nav = prev.base_cumulative_nav
        year_nav = cumulative_nav / base_cumulative_nav if base_cumulative_nav else Decimal("1.0")

    return NavResult(unit_nav, cumulative_nav, year_nav, shares, base_cumulative_nav)
