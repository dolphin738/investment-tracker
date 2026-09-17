"""分红明细展示文案纯函数单测（period_label / plan_label）。"""
from decimal import Decimal

from app.models.enums import ReportPeriodType
from app.services.dividend_period import period_label, plan_label


def test_period_label_annual_interim_quarterly():
    assert period_label(2025, 4, "ANNUAL") == "2025年报"
    assert period_label(2025, 2, "INTERIM") == "2025半年报"
    assert period_label(2025, 3, "QUARTERLY") == "2025三季报"
    assert period_label(2025, 1, "QUARTERLY") == "2025一季报"


def test_period_label_special_and_fallback():
    assert period_label(2023, 4, "SPECIAL") == "2023特别分配"
    # period_type 缺失 / 未知 → 按 report_quarter 回退判定
    assert period_label(2025, 4, None) == "2025年报"
    assert period_label(2025, 2, "UNKNOWN") == "2025半年报"


def test_period_label_enum_input():
    """ReportPeriodType 是 str 枚举：须取 .value，直接 str() 会得到 'ReportPeriodType.ANNUAL'。"""
    assert period_label(2025, 4, ReportPeriodType.ANNUAL) == "2025年报"
    assert period_label(2023, 4, ReportPeriodType.SPECIAL) == "2023特别分配"
    assert period_label(2025, 2, ReportPeriodType.INTERIM) == "2025半年报"


def test_plan_label():
    """源站口径「每 10 股派 X 元」，库内存每股金额 → 折算回 10 派 X 元。"""
    assert plan_label(Decimal("0.3")) == "10派3元"
    assert plan_label(Decimal("0.15")) == "10派1.5元"
    assert plan_label(Decimal("0")) == "10派0元"
    assert plan_label(Decimal("1.234567")) == "10派12.3457元"


def test_plan_label_invalid():
    assert plan_label(Decimal("NaN")) == "—"
    assert plan_label(None) == "—"
