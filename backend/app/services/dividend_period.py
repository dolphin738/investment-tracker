"""股息日期 / 报告期解析纯函数（无 IO，供 dividend_sync / 公告扫描 / 日线任务复用）。

从 ``dividend_sync.py`` 拆出（P2-6 文件拆分）：这些函数只做字符串 / 日期 / 季度算术，
不依赖会话与 ORM。独立成模块后既缩小 dividend_sync 体积，其它服务也不必绕道服务层
导入私有符号——故函数名去掉下划线前缀，跨模块复用即为公共 API。
"""
from __future__ import annotations

import calendar
import re
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
    """'现金分红-现金分红比例'（每 10 股派 X 元）→ 每股金额（÷10）。"""
    if raw in (None, "", "-"):
        return None
    try:
        return Decimal(str(raw).strip()) / Decimal("10")
    except (InvalidOperation, ValueError, TypeError):
        return None


def parse_date(raw: Any) -> Optional[date]:
    """通用日期解析（YYYYMMDD / YYYY-MM-DD / 连字符）；解析失败返回 None 不阻断。"""
    if raw in (None, "", "-", "nan", "None"):
        return None
    s = re.sub(r"[\s\-/年月]", "", str(raw).strip())
    if len(s) < 8:
        return None
    try:
        return date(int(s[:4]), int(s[4:6]), int(s[6:8]))
    except (ValueError, TypeError):
        return None


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
