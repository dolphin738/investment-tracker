"""股息率计算核心（纯函数，无 IO，便于单测穷举）。

口径与黄金断言见方案 §2.2-2.6：

- TTM：最新分红所在季度格子向前取满 4 个季度格子（跨年末尾衔接），按季度格子求和；
- LFY：最近一个完整财年的 Q1–Q4 全部分红之和；
- 分子为税前每股现金分红；股息率 = 分子 / 最新不复权收盘价（小数比率）。

本模块**不接触数据库**，输入为 ``DividendCell`` 最小投影；快照、曲线、排名均由调用方
把记录集投影为 ``DividendCell`` 后复用同一组函数（§9 一致性契约：曲线末点 == 快照值）。

派生指标（§8.2）：连续分红年数（断一年即止）、最近有分红财年、近两年无分红判定。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Optional

from app.models.enums import DividendStatus, DividendYieldMode

# 计入分子的状态（含预案口径）；REJECTED 一律剔除
_PAYABLE = (DividendStatus.PROPOSED, DividendStatus.PAID)

# 异常股息率判定阈值（决策 A12）：yield<=0 或 yield>0.30 置 suspicious（小数比率）
_SUSPICIOUS_UPPER = Decimal("0.30")

# 季度报告期期末日（§9 曲线锚点最后回退）：Q1→03-31、Q2→06-30、Q3→09-30、Q4→12-31
_PERIOD_END_MONTH_DAY = {1: (3, 31), 2: (6, 30), 3: (9, 30), 4: (12, 31)}


@dataclass(frozen=True)
class DividendCell:
    """分红事件输入（纯函数消费的最小投影，与 ORM 解耦）。

    ``period_type`` 为 ``ReportPeriodType`` 值字符串：SPECIAL 行的曲线锚点回退到公告日。
    """

    id: str
    report_year: int
    report_quarter: int
    period_type: str
    cash_per_share: Decimal
    status: DividendStatus
    ex_dividend_date: Optional[date]
    announcement_date: Optional[date]


@dataclass(frozen=True)
class YieldResult:
    """一次股息率计算结果（供快照/曲线/排名复用）。"""

    mode: DividendYieldMode
    numerator_per_share: Optional[Decimal]
    dividend_yield: Optional[Decimal]
    ref_div_ids: tuple[str, ...]


def payout_records(records: list[DividendCell]) -> list[DividendCell]:
    """过滤出计入分子的记录（排除 REJECTED）。"""
    return [r for r in records if r.status in _PAYABLE]


def _sort_desc(records: list[DividendCell]) -> list[DividendCell]:
    """按 (report_year, report_quarter) 倒序（D[0] 为最新分红）。"""
    return sorted(records, key=lambda r: (r.report_year, r.report_quarter), reverse=True)


def _quarter_cell(
    records: list[DividendCell], year: int, quarter: int
) -> tuple[Decimal, tuple[str, ...]]:
    """某季度格子的 (分子和, 参与记录 id)。无记录格子分子记 0。"""
    cells = [r for r in records if r.report_year == year and r.report_quarter == quarter]
    total = sum((r.cash_per_share for r in cells), Decimal("0"))
    return total, tuple(r.id for r in cells)


def _cells(records: list[DividendCell], year: int, quarter: int) -> tuple[Decimal, tuple[str, ...]]:
    """从 (year, quarter) 向前取满 4 个季度格子（跨年末尾衔接），分子求和并按格子收集 id。"""
    total = Decimal("0")
    ids: list[str] = []
    y, q = year, quarter
    for _ in range(4):
        cell_sum, cell_ids = _quarter_cell(records, y, q)
        total += cell_sum
        ids.extend(cell_ids)
        q -= 1
        if q == 0:
            q, y = 4, y - 1
    return total, tuple(ids)


def compute_yield(
    records: list[DividendCell], price: Optional[Decimal], current_year: int
) -> YieldResult:
    """计算股息率（掺比纯函数 §2.5）。``current_year`` 用于投喂当日财年（不影响分子，供扩展）。

    - ``price`` 为 None 时返回 ``dividend_yield=None``（缺失而非 0，§3.5）；
    - 无任何可计入记录时返回 ``(LFY, None, None, [])``。
    """
    payable = payout_records(records)
    if not payable:
        return YieldResult(DividendYieldMode.LFY, None, None, ())

    latest = _sort_desc(payable)[0]
    same_quarter_last_year = any(
        r.report_year == latest.report_year - 1
        and r.report_quarter == latest.report_quarter
        for r in payable
    )
    if latest.report_quarter == 4 or same_quarter_last_year:
        mode = DividendYieldMode.TTM
        numerator, ref_ids = _cells(payable, latest.report_year, latest.report_quarter)
    else:
        mode = DividendYieldMode.LFY
        # LFY：锚定最近完整财年（上一财年 Q1–Q4）。_cells 从锚点向前取满 4 格
        # （即锚点所在格回溯 3 格），故锚点须为 Q4 才能覆盖上一财年 Q1–Q4。
        numerator, ref_ids = _cells(payable, latest.report_year - 1, 4)

    if numerator is None or price is None or price <= 0:
        # price<=0（停牌异常价/脏数据）：股息率缺失而非 0（§3.5），且不得抛 DivisionByZero
        return YieldResult(mode, numerator, None, ref_ids)
    return YieldResult(mode, numerator, numerator / price, ref_ids)


def is_suspicious(yield_ratio: Optional[Decimal]) -> bool:
    """异常股息率判定（决策 A12）：yield<=0 或 yield>0.30 置 true（小数比率）。"""
    if yield_ratio is None:
        return False
    return yield_ratio <= 0 or yield_ratio > _SUSPICIOUS_UPPER


def consecutive_years(records: list[DividendCell], current_year: int) -> int:
    """连续分红年数（§8.2）：自当前财年起向前连续计数，某财年无可计入记录即止；上限受 5 年留存约束。

    近两年停发的公司自然计到 0，与"近两年无分红即剔除"自洽。
    """
    years = {r.report_year for r in payout_records(records)}
    count = 0
    y = current_year
    while y in years and count < 5:
        count += 1
        y -= 1
    return count


def last_dividend_year(records: list[DividendCell]) -> Optional[int]:
    """最近一次有分红的财年（§8.2）；无可计入记录时返回 None。"""
    years = [r.report_year for r in payout_records(records)]
    return max(years) if years else None


def has_recent_dividend(records: list[DividendCell], current_year: int, window: int = 2) -> bool:
    """近 ``window`` 个财年（含当年，按至今）内是否有可计入分红（§8.2 判定窗口）。"""
    return any(r.report_year >= current_year - window + 1 for r in payout_records(records))


def implied_price(numerator_per_share: Optional[Decimal], target_ratio: Optional[Decimal]) -> Optional[Decimal]:
    """反推价格（§9）：``implied_price = numerator / target_ratio``。入参 ``target_ratio`` 为小数比率。"""
    if numerator_per_share is None or target_ratio is None or target_ratio <= 0:
        return None
    return numerator_per_share / target_ratio


def _anchor_date(r: DividendCell) -> Optional[date]:
    """曲线归位锚点（§9）：``COALESCE(ex_dividend_date, announcement_date, 报告期期末日)``。

    - ``ex_dividend_date`` 优先（§3.4 三个日期语义）；
    - NULL 时回退**公告日**（预案公告即可见）——保证「含预案」快照与曲线末点一致
      （§9 一致性契约）：预案行 ex_date 恒空，若回退到报告期期末日（多在未来），
      快照计入而曲线不可见，末点 ≠ 快照；
    - 期末日为最后回退（公告日也缺失的数据缺失场景）；SPECIAL 行天然走公告日分支。
    锚点为 None（三者全无）时该记录在任何时点均不可见。
    """
    if r.ex_dividend_date is not None:
        return r.ex_dividend_date
    if r.announcement_date is not None:
        return r.announcement_date
    month_day = _PERIOD_END_MONTH_DAY.get(r.report_quarter)
    if month_day is None:
        return None
    return date(r.report_year, month_day[0], month_day[1])


def compute_yield_at(
    records: list[DividendCell],
    as_of: date,
    price: Optional[Decimal],
    current_year: int,
) -> YieldResult:
    """曲线逐点计算（§9）：输入「截至 as_of 可见的记录集 + 该日收盘价」复用 ``compute_yield``。

    可见判定锚点为 ``_anchor_date``（``COALESCE(ex_dividend_date, announcement_date, 期末日)``）。
    保证曲线末点 == 快照值：预案行（ex_date 恒空）公告即可见，与「含预案」快照同口径。
    """
    visible = [
        r for r in records if (_anchor_date(r) is not None and _anchor_date(r) <= as_of)
    ]
    return compute_yield(visible, price, current_year)