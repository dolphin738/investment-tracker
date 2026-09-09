"""股息日期 / 报告期解析纯函数（无 IO，供 dividend_sync / 公告扫描 / 日线任务复用）。

从 ``dividend_sync.py`` 拆出（P2-6 文件拆分）：这些函数只做字符串 / 日期 / 季度算术，
不依赖会话与 ORM。独立成模块后既缩小 dividend_sync 体积，其它服务也不必绕道服务层
导入私有符号——故函数名去掉下划线前缀，跨模块复用即为公共 API。
"""
from __future__ import annotations

import calendar
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

# 报告期 → 季度（§6.1：0331 Q1 / 0630 Q2 / 0930 Q3 / 1231 Q4）
_PERIOD_QUARTER = {3: 1, 6: 2, 9: 3, 12: 4}


def parse_report_period(raw: Any) -> Optional[tuple[int, int]]:
    """'报告期' → (year, quarter)；无法解析返回 None（跳行）。"""
    if raw is None:
        return None
    s = str(raw).strip()
    if len(s) < 4:
        return None
    try:
        year = int(s[:4])
        mm = int(s[4:6])
    except (ValueError, TypeError):
        return None
    quarter = _PERIOD_QUARTER.get(mm)
    if quarter is None or year <= 0:
        return None
    return year, quarter


def parse_cash(raw: Any) -> Optional[Decimal]:
    """'现金分红-现金分红比例'（每 10 股派 X 元）→ 每股金额（÷10）。

    ``Decimal('NaN')`` 是合法构造（上游对缺失金额会返回字符串 "NaN"），须显式
    判 ``is_nan`` 归为 None——否则 NaN 落库后经求和传播污染快照（§3.5 缺失语义）。
    """
    if raw in (None, "", "-"):
        return None
    try:
        d = Decimal(str(raw).strip())
        if d.is_nan():
            return None
        return d / Decimal("10")
    except (InvalidOperation, ValueError, TypeError):
        return None


def current_quarter(d: date) -> tuple[int, int]:
    """当天所属报告期（2026-09-08 → (2026, 3)）。"""
    return d.year, (d.month - 1) // 3 + 1


def is_future_period(year: int, quarter: int, today: date) -> bool:
    """报告期晚于「今天所属季度」 → 未来报告期（源站无数据，抓取必失败，应跳过）。

    季度抓取的报告期网格按「整年 × 四季」生成，天然会包含尚未进入的期次
    （如 2026-09 生成 2026Q4，报告期 2026-12-31）。东财对其返回 ``result=null``，
    akshare 直接 ``data_json["result"]["pages"]`` 会抛
    ``TypeError: 'NoneType' object is not subscriptable``。

    判据取「严格晚于当前季度」而非「晚于报告期结束日」：当季（如 2026-09-08 查
    2026Q3）源站通常已有部分披露，按结束日（09-30）判定会误伤当季已有数据。
    """
    return (year, quarter) > current_quarter(today)


def back_n_quarters(year: int, quarter: int, n: int) -> tuple[int, int]:
    """从 (year, quarter) 向前回退 n 个季度（跨年末尾衔接）。"""
    q = quarter - n
    y = year
    while q <= 0:
        q += 4
        y -= 1
    return y, q


def last_day(d: date) -> int:
    """当月最后一天。"""
    return calendar.monthrange(d.year, d.month)[1]


def subtract_years(d: date, years: int) -> date:
    """日期减 N 年（保留月日；2/29 回退到 2/28 安全性：日线留存只需年界）。"""
    try:
        return d.replace(year=d.year - years)
    except ValueError:
        return d.replace(year=d.year - years, month=2, day=28)
