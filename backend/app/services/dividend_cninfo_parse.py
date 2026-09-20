"""巨潮历史分红接口（``stock_dividend_cninfo``）响应行的纯解析（无 IO / 无会话）。

从 ``dividend_notice_scan.py`` 拆出（方案 §5.3 / §5.3.1）：把「11 列响应行 → 目标列」
的映射与换算收口为可单测的纯函数，服务层只负责调度与落库，同时把该文件压回 400 行内。

列名取 akshare 重命名后的中文列（实测响应 **无代码列**，证券代码来自调用方传入的
``symbol``，与旧新浪路径口径一致）。三个未用列（派息日 / 股份到账日 / 实施方案分红说明）
按 §9.3-A6 仅保留常量、**不落库**。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any, Optional

from app.core.date_utils import parse_date
from app.models.enums import DividendStatus, ReportPeriodType
from app.services.dividend_period import parse_cash, parse_report_period_cn
from app.services.market_data_sync import _row_get

# —— 响应列名（akshare stock_dividend_cninfo 重命名后共 11 列）——
COL_ANN = "实施方案公告日期"
COL_PERIOD_TYPE = "分红类型"
COL_CONVERT = "转增比例"
COL_BONUS = "送股比例"
COL_CASH = "派息比例"
COL_RECORD = "股权登记日"
COL_EX = "除权日"
COL_PAY = "派息日"
COL_ARRIVE = "股份到账日"
COL_DESC = "实施方案分红说明"
COL_REPORT = "报告时间"

# 「分红类型」→ period_type（§5.3）：年度分红→ANNUAL、中期分红→INTERIM、其余→QUARTERLY
_PERIOD_TYPE_BY_LABEL: dict[str, ReportPeriodType] = {
    "年度分红": ReportPeriodType.ANNUAL,
    "中期分红": ReportPeriodType.INTERIM,
}

# 留存财年数（真 5 年，§9.3-A3）：保留 [cur-4, cur]，与 dividend_sync.retention_cleanup
# 的 cutoff = cur - 5 + 1 严格对齐，否则播种写入的第 6 个年度会被下次清理删掉。
RETAIN_YEARS = 5


@dataclass(frozen=True)
class CninfoDividendRow:
    """单行巨潮分红解析结果（已按 §5.3 完成单位换算与语义推导）。"""

    period_type: ReportPeriodType
    report_year: int
    report_quarter: int
    cash_per_share: Decimal
    status: DividendStatus
    ex_dividend_date: Optional[date]
    record_date: Optional[date]
    announcement_date: Optional[date]
    bonus_share_ratio: Optional[Decimal]
    convert_ratio: Optional[Decimal]


def retention_cutoff_year(today: date) -> int:
    """留存窗口下界财年：保留 [today.year - RETAIN_YEARS + 1, today.year]。"""
    return today.year - RETAIN_YEARS + 1


def parse_period_type(raw: Any) -> ReportPeriodType:
    """「分红类型」→ ReportPeriodType；未收录的标签一律 QUARTERLY（§5.3）。"""
    return _PERIOD_TYPE_BY_LABEL.get(str(raw or "").strip(), ReportPeriodType.QUARTERLY)


def parse_cninfo_row(row: Any) -> Optional[CninfoDividendRow]:
    """巨潮单行 → 目标列映射；该行应被跳过时返回 None。

    跳过两类行（§5.3 / §9.3-A1）：
    - **派息比例为空 / NaN / 显式 0** → 纯送转行不落库（不撑起「连续分红」计数）；
    - **「报告时间」不可解析** → 无报告期归属，无法落唯一键。

    金额单位一律折算为**每股**（源为「每 10 股」÷10，与 ``cash_per_share`` 同口径）；
    ``status`` 按 §9.3-A2：除权日非空 → PAID，否则 → PROPOSED（巨潮无「进度」列）。
    """
    cash = parse_cash(_row_get(row, COL_CASH))
    if cash is None or cash == 0:
        return None
    period = parse_report_period_cn(_row_get(row, COL_REPORT))
    if period is None:
        return None
    ex_date = parse_date(_row_get(row, COL_EX))
    return CninfoDividendRow(
        period_type=parse_period_type(_row_get(row, COL_PERIOD_TYPE)),
        report_year=period[0],
        report_quarter=period[1],
        cash_per_share=cash,
        status=DividendStatus.PAID if ex_date is not None else DividendStatus.PROPOSED,
        ex_dividend_date=ex_date,
        record_date=parse_date(_row_get(row, COL_RECORD)),
        announcement_date=parse_date(_row_get(row, COL_ANN)),
        bonus_share_ratio=parse_cash(_row_get(row, COL_BONUS)),
        convert_ratio=parse_cash(_row_get(row, COL_CONVERT)),
    )
