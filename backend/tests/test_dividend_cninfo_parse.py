"""巨潮分红纯解析单测（批次 A）：5 项标签映射 / OTHER 兜底 / 原文标签透传 / 分桶。

不触网络、不触数据库；纯函数可直接断言。配合 ``test_dividend_period_label``（展示文案）
与 ``test_dividend_notice_scan``（端到端）形成批次 A 解析层护栏。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from app.models.enums import ReportPeriodType
from app.services.dividend_cninfo_parse import (
    COL_ANN,
    COL_BONUS,
    COL_CASH,
    COL_CONVERT,
    COL_EX,
    COL_PAY,
    COL_PERIOD_TYPE,
    COL_RECORD,
    COL_REPORT,
    normalize_label,
    parse_cninfo_row_ex,
    parse_pending_row,
    parse_period_type,
    pending_fingerprint,
)


# ───────────── #4 5 项精确映射（含「股改分红」→ OTHER） ─────────────
def test_period_type_five_way_mapping():
    """§5.3（批次 A）：分红类型 5 项精确映射，股改分红→OTHER。"""
    assert parse_period_type("年度分红") is ReportPeriodType.ANNUAL
    assert parse_period_type("中期分红") is ReportPeriodType.INTERIM
    assert parse_period_type("季度分红") is ReportPeriodType.QUARTERLY
    assert parse_period_type("特别分红") is ReportPeriodType.SPECIAL
    assert parse_period_type("股改分红") is ReportPeriodType.OTHER


# ───────────── #5 未收录/空/None → OTHER ─────────────
def test_period_type_unknown_and_empty_fall_to_other():
    """未收录标签（重整转增/承诺补偿）与空/None 一律兜底 OTHER。"""
    assert parse_period_type("") is ReportPeriodType.OTHER
    assert parse_period_type(None) is ReportPeriodType.OTHER
    assert parse_period_type("重整转增") is ReportPeriodType.OTHER
    assert parse_period_type("承诺补偿") is ReportPeriodType.OTHER


# ───────────── #6 反向：股改不落 SPECIAL ─────────────
def test_period_type_sharereform_is_not_special():
    """反向钉死：股改分红必须落 OTHER，绝不混入 SPECIAL。"""
    assert parse_period_type("股改分红") is not ReportPeriodType.SPECIAL
    assert parse_period_type("股改分红") is ReportPeriodType.OTHER


# ───────────── #7 原文标签透传（parse_cninfo_row_ex） ─────────────
def test_parse_cninfo_row_ex_transports_original_label():
    """原文「分红类型」标签透传进 CninfoDividendRow.dividend_label。"""
    row, reason = parse_cninfo_row_ex({
        COL_PERIOD_TYPE: "股改分红",
        COL_CASH: "100",
        COL_REPORT: "2025年报",
        COL_EX: "2025-06-10",
    })
    assert reason is None
    assert row is not None
    assert row.dividend_label == "股改分红"
    assert row.period_type is ReportPeriodType.OTHER


# ───────────── #8 空标签 → None（parse_cninfo_row_ex） ─────────────
def test_parse_cninfo_row_ex_empty_label_is_none():
    """空/缺失标签归一到 dividend_label=None（落 OTHER 但不带原文）。"""
    row, reason = parse_cninfo_row_ex({
        COL_PERIOD_TYPE: "",
        COL_CASH: "100",
        COL_REPORT: "2025年报",
        COL_EX: "2025-06-10",
    })
    assert reason is None
    assert row is not None
    assert row.dividend_label is None

    row2, reason2 = parse_cninfo_row_ex({
        COL_CASH: "100",
        COL_REPORT: "2025年报",
        COL_EX: "2025-06-10",
    })
    assert reason2 is None
    assert row2 is not None
    assert row2.dividend_label is None


# ───────────── #9 分桶：no_cash / no_period ─────────────
def test_parse_cninfo_row_ex_buckets_no_cash_and_no_period():
    """parse_cninfo_row_ex 拆桶：纯送转→no_cash，有派息无报告期→no_period。"""
    parsed, reason = parse_cninfo_row_ex({
        COL_PERIOD_TYPE: "年度分红", COL_CASH: "", COL_REPORT: "2025年报",
    })
    assert parsed is None and reason == "no_cash"

    parsed, reason = parse_cninfo_row_ex({
        COL_PERIOD_TYPE: "年度分红", COL_CASH: "0", COL_REPORT: "2025年报",
    })
    assert parsed is None and reason == "no_cash"

    parsed, reason = parse_cninfo_row_ex({
        COL_PERIOD_TYPE: "年度分红", COL_CASH: "100", COL_REPORT: "",
    })
    assert parsed is None and reason == "no_period"


# ───────────── #4 补充边界：no_cash 优先于 no_period / 32 字符截断 ─────────────
def test_parse_cninfo_row_ex_no_cash_priority_over_no_period():
    """交叉场景：cash=0 且 report 空 → 归 no_cash（证明 no_cash 优先于 no_period）。"""
    parsed, reason = parse_cninfo_row_ex({
        COL_PERIOD_TYPE: "年度分红", COL_CASH: "0", COL_REPORT: "",
    })
    assert parsed is None and reason == "no_cash"


def test_normalize_label_truncates_to_32_and_period_other():
    """超长标签截断到 32 字符；未收录长标签落 OTHER 且 dividend_label 同步截断。"""
    long_label = "X" * 40
    assert len(normalize_label(long_label)) == 32

    row, _reason = parse_cninfo_row_ex({
        COL_PERIOD_TYPE: long_label,
        COL_CASH: "100",
        COL_REPORT: "2025年报",
        COL_EX: "2025-06-10",
    })
    assert row is not None
    assert row.period_type is ReportPeriodType.OTHER
    assert row.dividend_label is not None
    assert len(row.dividend_label) == 32


# ───────────── 批次 B：parse_pending_row（§3.1） ─────────────
def test_parse_pending_row_maps_columns_and_units():
    """巨潮行 → PendingDividendRow：金额 ÷10 折每股、日期解析、标签/报告时间原文透传。"""
    row = parse_pending_row({
        COL_PERIOD_TYPE: "股改分红",
        COL_CASH: "219.1",
        COL_BONUS: "3",
        COL_CONVERT: "5",
        COL_RECORD: "2025-06-09",
        COL_EX: "2025-06-10",
        COL_PAY: "2025-06-20",
        COL_ANN: "2025-05-20",
        COL_REPORT: "未知报告期",
    })
    assert row.dividend_label == "股改分红"
    assert row.cash_per_share == Decimal("21.91")     # 219.1 / 10
    assert row.bonus_share_ratio == Decimal("0.3")    # 3 / 10
    assert row.convert_ratio == Decimal("0.5")        # 5 / 10
    assert row.record_date == date(2025, 6, 9)
    assert row.ex_dividend_date == date(2025, 6, 10)
    assert row.pay_date == date(2025, 6, 20)
    assert row.announcement_date == date(2025, 5, 20)
    assert row.report_period_raw == "未知报告期"


def test_parse_pending_row_empty_and_missing_are_none():
    """空标签 / 空报告时间 → None；日期列缺失 → None；金额缺失兜底 0（列 NOT NULL）。"""
    row = parse_pending_row({
        COL_PERIOD_TYPE: "",
        COL_CASH: "",
        COL_REPORT: "",
    })
    assert row.dividend_label is None
    assert row.report_period_raw is None
    assert row.cash_per_share == Decimal("0")
    assert row.bonus_share_ratio is None
    assert row.convert_ratio is None
    assert row.ex_dividend_date is None
    assert row.pay_date is None


def test_parse_pending_row_nan_guards():
    """NaN 金额 / 标签 → None（复用 parse_cash / _normalize_text 的 NaN 守卫）。"""
    row = parse_pending_row({
        COL_PERIOD_TYPE: float("nan"),
        COL_CASH: "NaN",
        COL_BONUS: "NaN",
        COL_REPORT: float("nan"),
    })
    assert row.dividend_label is None
    assert row.report_period_raw is None
    assert row.cash_per_share == Decimal("0")
    assert row.bonus_share_ratio is None


# ───────────── 批次 B：pending_fingerprint（§3.6） ─────────────
def test_pending_fingerprint_stable_and_sha1_length():
    """同输入同输出；sha1 hex 恒 40 字符。"""
    raw = {
        COL_PERIOD_TYPE: "年度分红", COL_CASH: "100", COL_BONUS: "3", COL_CONVERT: "5",
        COL_RECORD: "2025-06-09", COL_EX: "2025-06-10", COL_PAY: "2025-06-20",
        COL_ANN: "2025-05-20", COL_REPORT: "",
    }
    fp1 = pending_fingerprint("mid-1", parse_pending_row(dict(raw)))
    fp2 = pending_fingerprint("mid-1", parse_pending_row(dict(raw)))
    assert fp1 == fp2
    assert len(fp1) == 40
    assert all(c in "0123456789abcdef" for c in fp1)


def test_pending_fingerprint_field_sensitive():
    """任一纳入字段变化 → 指纹变化（含 master_id）。"""
    base_raw = {
        COL_PERIOD_TYPE: "年度分红", COL_CASH: "100", COL_BONUS: "3", COL_CONVERT: "5",
        COL_RECORD: "2025-06-09", COL_EX: "2025-06-10", COL_PAY: "2025-06-20",
        COL_ANN: "2025-05-20", COL_REPORT: "",
    }
    base_fp = pending_fingerprint("mid-1", parse_pending_row(dict(base_raw)))

    assert pending_fingerprint("mid-2", parse_pending_row(dict(base_raw))) != base_fp
    for key, value in (
        (COL_CASH, "200"), (COL_BONUS, "4"), (COL_CONVERT, "6"),
        (COL_PERIOD_TYPE, "中期分红"), (COL_EX, "2025-07-10"), (COL_REPORT, "2025三季报"),
    ):
        changed = dict(base_raw)
        changed[key] = value
        assert pending_fingerprint("mid-1", parse_pending_row(changed)) != base_fp
