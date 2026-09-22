"""巨潮历史分红接口（``stock_dividend_cninfo``）响应行的纯解析（无 IO / 无会话）。

从 ``dividend_notice_scan.py`` 拆出（方案 §5.3 / §5.3.1）：把「11 列响应行 → 目标列」
的映射与换算收口为可单测的纯函数，服务层只负责调度与落库；公告扫描服务的主流程与
公告/明细源解析能力已分别分散在 ``dividend_notice_scan.py``（落库）与
``dividend_notice_meta.py``（二筛 + 选源，§6.3），三者各自控制在单文件行数约定内。

列名取 akshare 重命名后的中文列（实测响应 **无代码列**，证券代码来自调用方传入的
``symbol``，与旧新浪路径口径一致）。三个未用列（派息日 / 股份到账日 / 实施方案分红说明）
按 §9.3-A6 仅保留常量、**不落库**。
"""
from __future__ import annotations

import hashlib
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

# 「分红类型」→ period_type（§5.3，批次 A 扩到 5 项精确映射）：
# 年度分红→ANNUAL、中期分红→INTERIM、季度分红→QUARTERLY、特别分红→SPECIAL、
# 股改分红→OTHER（股改不单列枚举，落 OTHER，原文存 dividend_label）。未收录标签也→OTHER。
_PERIOD_TYPE_BY_LABEL: dict[str, ReportPeriodType] = {
    "年度分红": ReportPeriodType.ANNUAL,
    "中期分红": ReportPeriodType.INTERIM,
    "季度分红": ReportPeriodType.QUARTERLY,
    "特别分红": ReportPeriodType.SPECIAL,
    "股改分红": ReportPeriodType.OTHER,
}

# 已收录的「分红类型」原文标签（撞键/未知标签判定用）：命中则不记 unknown_label。
KNOWN_LABELS = frozenset(_PERIOD_TYPE_BY_LABEL)

# 留存财年数（§9.3-A3）：保留 [cur-years+1, cur]，与 ``dividend_sync.retention_cleanup`` 的
# cutoff 公式一致。years 由调用方从 ``settings.dividend_retention_years`` 传入（默认回落
# ``DEFAULT_DIVIDEND_RETENTION_YEARS``），采集窗与清理窗共用同一配置 → 由构造保证对齐；
# 不再在此硬编码常量，否则配置改非 5 时写入的年度会被下次清理删掉。


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
    # 原文「分红类型」标签（如「股改分红」「重整转增」）：展示与撞键判别用，**不入唯一键**。
    dividend_label: Optional[str]


def retention_cutoff_year(today: date, years: int) -> int:
    """留存窗口下界财年：保留 [today.year - years + 1, today.year]（真 N 年）。

    ``years`` 由调用方从 ``settings.dividend_retention_years`` 传入，确保采集窗与
    ``retention_cleanup`` 的清理窗使用同一配置值（默认回落 ``DEFAULT_DIVIDEND_RETENTION_YEARS``）。
    """
    return today.year - years + 1


def _normalize_text(raw: Any) -> Optional[str]:
    """通用文本归一：strip + 截断 32；空/全空白/NaN → None。

    ⚠️ 先挡 NaN：``float('nan')`` 是 truthy，``str()`` 会得到字符串 ``'nan'``，与缺失同义须
    归 None；否则缺标签会被存成字符串 ``'nan'`` 还被当成「非空未知标签」计入 unknown_label。
    与同文件 ``parse_cash`` 口径一致（显式挡 ``is_nan``）。
    """
    # NaN 自不等（``nan != nan`` 恒成立），免去 math import
    if raw is None or (isinstance(raw, float) and raw != raw):
        return None
    s = str(raw or "").strip()
    if not s:
        return None
    return s[:32]


def normalize_label(raw: Any) -> Optional[str]:
    """「分红类型」原文标签归一（strip + 截断 32，空/全空白/NaN → None）。"""
    return _normalize_text(raw)


def parse_period_type(raw: Any) -> ReportPeriodType:
    """「分红类型」→ ReportPeriodType；未收录的标签一律 ``OTHER``（§5.3，批次 A）。"""
    return _PERIOD_TYPE_BY_LABEL.get(str(raw or "").strip(), ReportPeriodType.OTHER)


def parse_cninfo_row_ex(row: Any) -> tuple[Optional[CninfoDividendRow], Optional[str]]:
    """巨潮单行 → 目标列映射；返回 ``(CninfoDividendRow | None, 跳过原因 | None)``。

    跳过两类行（§5.3 / §9.3-A1，批次 A 拆桶可观测）：
    - **派息比例为空 / NaN / 显式 0** → 纯送转行不落库，原因 ``"no_cash"``；
    - **「报告时间」不可解析** → 无报告期归属无法落唯一键，原因 ``"no_period"``。

    ⚠️ 判据顺序**不可调换**：``no_cash`` 优先于 ``no_period``（纯送转行即使无报告期也
    只应计无派息，不污染无报告期计数）。

    金额单位一律折算为**每股**（源为「每 10 股」÷10，与 ``cash_per_share`` 同口径）；
    ``status`` 按 §9.3-A2：除权日非空 → PAID，否则 → PROPOSED（巨潮无「进度」列）。
    原文标签经 ``normalize_label`` 归一并截断，空标签落 ``dividend_label=None``。
    """
    cash = parse_cash(_row_get(row, COL_CASH))
    if cash is None or cash == 0:
        return None, "no_cash"
    period = parse_report_period_cn(_row_get(row, COL_REPORT))
    if period is None:
        return None, "no_period"
    raw_label = _row_get(row, COL_PERIOD_TYPE)
    ex_date = parse_date(_row_get(row, COL_EX))
    return CninfoDividendRow(
        period_type=parse_period_type(raw_label),
        report_year=period[0],
        report_quarter=period[1],
        cash_per_share=cash,
        status=DividendStatus.PAID if ex_date is not None else DividendStatus.PROPOSED,
        ex_dividend_date=ex_date,
        record_date=parse_date(_row_get(row, COL_RECORD)),
        announcement_date=parse_date(_row_get(row, COL_ANN)),
        bonus_share_ratio=parse_cash(_row_get(row, COL_BONUS)),
        convert_ratio=parse_cash(_row_get(row, COL_CONVERT)),
        dividend_label=normalize_label(raw_label),
    ), None


# —— 批次 B：待人工划分 staging 行（§3.1 / §3.6）——


@dataclass(frozen=True)
class PendingDividendRow:
    """待划分 staging 行（批次 B，§3.1）：现金 >0 但「报告时间」不可解析的巨潮行。

    金额一律为**每股**（源「每 10 股」÷10）；日期不可解析为 None；原文标签 / 报告时间
    经归一（空 → None）。经 ``parse_pending_row`` 构造、``stage_pending`` 落库。
    """

    dividend_label: Optional[str]
    cash_per_share: Decimal
    bonus_share_ratio: Optional[Decimal]
    convert_ratio: Optional[Decimal]
    record_date: Optional[date]
    ex_dividend_date: Optional[date]
    pay_date: Optional[date]
    announcement_date: Optional[date]
    report_period_raw: Optional[str]

    def fields(self) -> dict[str, Any]:
        """映射到 ``security_dividend_pending`` 的列值。

        仅含业务列（不含 ``id`` / ``row_fingerprint`` / ``status`` 与
        ``resolved_*`` / 时间戳——后者由服务层或 DB 默认值补齐）。
        """
        return {
            "dividend_label": self.dividend_label,
            "cash_per_share": self.cash_per_share,
            "bonus_share_ratio": self.bonus_share_ratio,
            "convert_ratio": self.convert_ratio,
            "record_date": self.record_date,
            "ex_dividend_date": self.ex_dividend_date,
            "pay_date": self.pay_date,
            "announcement_date": self.announcement_date,
            "report_period_raw": self.report_period_raw,
        }


def parse_pending_row(row: Any) -> PendingDividendRow:
    """巨潮单行 → 待划分 staging 行（批次 B，§3.1）。

    仅由 ``fetch_and_upsert_master`` 对「现金 >0 且报告时间不可解析」（``no_period``）的行
    调用；自巨潮原始行取：分红类型原文、派息（÷10 每股）、送股（÷10）、转增（÷10）、
    股权登记日、除权日、**派息日**、公告日、报告时间原文。日期走
    ``app.core.date_utils.parse_date``；金额走 ``parse_cash``（NaN 守卫）；文本走
    ``_normalize_text``（空 / 全空白 → None）。

    ``cash_per_share`` 列 NOT NULL：解析不出金额时兜底为 ``Decimal("0")``（正常调用路径
    已由 ``no_period`` 桶保证现金 >0）。
    """
    cash = parse_cash(_row_get(row, COL_CASH))
    return PendingDividendRow(
        dividend_label=_normalize_text(_row_get(row, COL_PERIOD_TYPE)),
        cash_per_share=cash if cash is not None else Decimal("0"),
        bonus_share_ratio=parse_cash(_row_get(row, COL_BONUS)),
        convert_ratio=parse_cash(_row_get(row, COL_CONVERT)),
        record_date=parse_date(_row_get(row, COL_RECORD)),
        ex_dividend_date=parse_date(_row_get(row, COL_EX)),
        pay_date=parse_date(_row_get(row, COL_PAY)),
        announcement_date=parse_date(_row_get(row, COL_ANN)),
        report_period_raw=_normalize_text(_row_get(row, COL_REPORT)),
    )


def pending_fingerprint(master_id: str, row: PendingDividendRow) -> str:
    """身份指纹：``sha1('\\x1f'.join(canonical fields)).hexdigest()``（40 hex）。

    字段顺序固定、缺失归一为空串，保证「同一源行重复 scan → 同一指纹」。纳入字段：
    ``master_id | dividend_label | cash_per_share | bonus_share_ratio | convert_ratio
    | record_date | ex_dividend_date | pay_date | announcement_date | report_period_raw``。

    含 ``master_id``：表内跨证券去重（同源行归属唯一证券）。用 sha1 文本列而非复合唯一键：
    复合键含可空日期，PG 唯一索引对 NULL 视为互不相等，无法幂等（§3.6）。

    归一化细节：``bonus_share_ratio`` / ``convert_ratio`` 的 ``Decimal("0")`` 与 ``None``
    经 ``x or ""`` 归一为**同一空串** → 产出**同一指纹**（语义上二者均表示「无送转」，
    去重意图正确，不应因「显式 0」与「缺失」而分裂成两行待办）。
    """
    canonical = "\x1f".join([
        master_id,
        row.dividend_label or "",
        str(row.cash_per_share),
        str(row.bonus_share_ratio or ""),
        str(row.convert_ratio or ""),
        str(row.record_date or ""),
        str(row.ex_dividend_date or ""),
        str(row.pay_date or ""),
        str(row.announcement_date or ""),
        row.report_period_raw or "",
    ])
    return hashlib.sha1(canonical.encode("utf-8")).hexdigest()


