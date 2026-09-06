"""股息率纯函数核心单测（基于方案 §2.2-2.6 / §8.2 / §9 决策 A12 / A6）。

零 DB 依赖，直接调用 ``app/services/dividend_yield.py`` 暴露的纯函数，
对齐附录 A.6 与 §3.1 状态口径。每个测试标注守护的决策/章节编号。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from app.models.enums import DividendStatus, DividendYieldMode, ReportPeriodType
from app.services.dividend_yield import (
    DividendCell,
    compute_yield,
    compute_yield_at,
    consecutive_years,
    has_recent_dividend,
    implied_price,
    is_suspicious,
    last_dividend_year,
    payout_records,
)


def _cell(
    rid: str,
    year: int,
    quarter: int,
    cash: str,
    status: DividendStatus = DividendStatus.PAID,
    ex: str | None = None,
    ann: str | None = None,
    ptype: ReportPeriodType = ReportPeriodType.ANNUAL,
) -> DividendCell:
    """构造最小投影单元格（ex/ann 为 YYYY-MM-DD 或 None）。"""
    return DividendCell(
        id=rid,
        report_year=year,
        report_quarter=quarter,
        period_type=ptype.value,
        cash_per_share=Decimal(cash),
        status=status,
        ex_dividend_date=date.fromisoformat(ex) if ex else None,
        announcement_date=date.fromisoformat(ann) if ann else None,
    )


# ───────────────────────── 状态口径（§3.1 / 附录 A.6） ─────────────────────────
def test_payout_records_excludes_rejected():
    """守护 §3.1：REJECTED 剔除出分子，PROPOSED/PAID 计入。"""
    cells = [
        _cell("a", 2025, 4, "1.0", DividendStatus.PAID),
        _cell("b", 2025, 4, "2.0", DividendStatus.PROPOSED),
        _cell("c", 2025, 4, "3.0", DividendStatus.REJECTED),
    ]
    kept = payout_records(cells)
    ids = {r.id for r in kept}
    assert "c" not in ids  # REJECTED 不参与分子
    assert {"a", "b"} <= ids


def test_compute_rejected_not_in_numerator():
    """守护 §3.1：REJECTED 金额不计入分子（仅 PAID 计数）。"""
    cells = [
        _cell("a", 2025, 4, "1.0", DividendStatus.PAID),
        _cell("c", 2025, 4, "9.9", DividendStatus.REJECTED),
    ]
    res = compute_yield(cells, Decimal("10"), 2026)
    assert res.numerator_per_share == Decimal("1.0")  # 9.9 被剔除
    assert res.dividend_yield == Decimal("0.1")


# ───────────────────────── TTM 锚定（§2.3 + 跨年末尾衔接） ─────────────────────────
def test_ttm_annual_q4_anchors_back_four_cells():
    """守护 §2.5：最新季为年报 Q4 → TTM，取 Q4 向前满 4 格。"""
    cells = [
        _cell("a", 2025, 4, "0.50"),
        _cell("b", 2025, 3, "0.40"),
        _cell("c", 2025, 2, "0.30"),
        _cell("c3", 2025, 1, "0.20"),
    ]
    res = compute_yield(cells, Decimal("7.0"), 2026)
    assert res.mode == DividendYieldMode.TTM
    assert res.numerator_per_share == Decimal("1.40")
    assert res.dividend_yield == Decimal("0.2")
    assert tuple(res.ref_div_ids) == ("a", "b", "c", "c3")


def test_ttm_cross_year_boundary():
    """守护 §2.3 跨末衔接：最新同季上年存在 → TTM，且 4 格跨年取满。"""
    cells = [
        # 2025 Q1（最新），且 2024 Q1 存在 → 同季上年在 → TTM
        _cell("y25q1", 2025, 1, "0.30"),
        _cell("y24q4", 2024, 4, "0.20"),
        _cell("y24q3", 2024, 3, "0.50"),
        _cell("y24q2", 2024, 2, "0.40"),
        _cell("y24q1", 2024, 1, "9.99"),  # 同格触发 TTM，但不在取满 4 格内
    ]
    res = compute_yield(cells, Decimal("7.0"), 2026)
    assert res.mode == DividendYieldMode.TTM
    # 从 (2025,1) 回 4 格 = (2025,1)(2024,4)(2024,3)(2024,2)，不含 (2024,1)
    assert res.numerator_per_share == Decimal("1.40")
    assert tuple(res.ref_div_ids) == ("y25q1", "y24q4", "y24q3", "y24q2")


# ───────────────────────── LFY 锚定（§2.4） ─────────────────────────
def test_lfy_interim_uses_last_complete_fiscal_year():
    """守护 §2.4：最新季为半年报 Q2 且无同季上年 → LFY，取上一完整财年 Q1-Q4。"""
    cells = [
        _cell("y25q2", 2025, 2, "0.25"),  # 最新（半年报），无 2024Q2 → LFY
        _cell("y24q1", 2024, 1, "0.25"),
        _cell("y24q3", 2024, 3, "0.25"),
        _cell("y24q4", 2024, 4, "0.25"),
    ]
    res = compute_yield(cells, Decimal("10"), 2026)
    assert res.mode == DividendYieldMode.LFY
    assert res.numerator_per_share == Decimal("0.75")  # 2024 可计入三个格子之和
    assert res.dividend_yield == Decimal("0.075")
    assert tuple(res.ref_div_ids) == ("y24q4", "y24q3", "y24q1")  # _cells 自锚点 Q4 回溯收集


# ───────────────────────── mode 判定三态（§2.5） ─────────────────────────
def test_mode_determination_cases():
    """守护 §2.5：年报 Q4 / 同季上年存在 → TTM；半年报无同季 → LFY。"""
    # 年报 Q4 → TTM
    annual = [_cell("a", 2025, 4, "1.0")]
    assert compute_yield(annual, None, 2026).mode == DividendYieldMode.TTM
    # 半年报 Q2 且无同季上年 → LFY
    interim = [_cell("b", 2025, 2, "1.0")]
    assert compute_yield(interim, None, 2026).mode == DividendYieldMode.LFY
    # 季报 Q3 且 2024 Q3 存在 → TTM
    same_q = [
        _cell("c", 2025, 3, "1.0"),
        _cell("d", 2024, 3, "1.0"),
    ]
    assert compute_yield(same_q, None, 2026).mode == DividendYieldMode.TTM


# ───────────────────────── 价格缺失 / 空集（§3.5） ─────────────────────────
def test_price_none_returns_yield_none_not_zero():
    """守护 §3.5：price=None → dividend_yield=None（缺失而非 0），分子仍在。"""
    cells = [_cell("a", 2025, 4, "1.0")]
    res = compute_yield(cells, None, 2026)
    assert res.numerator_per_share == Decimal("1.0")
    assert res.dividend_yield is None


def test_no_payable_returns_empty_result():
    """守护 §2.5：无可计入记录 → (LFY, None, None, [])。"""
    cells = [_cell("a", 2025, 4, "1.0", DividendStatus.REJECTED)]
    res = compute_yield(cells, Decimal("10"), 2026)
    assert res.mode == DividendYieldMode.LFY
    assert res.numerator_per_share is None
    assert res.dividend_yield is None
    assert res.ref_div_ids == ()


# ───────────────────────── suspicious（决策 A12） ─────────────────────────
def test_is_suspicious_thresholds():
    """守护决策 A12：yield<=0 或 >0.30 置 suspicious；None/正常位不置。"""
    assert is_suspicious(Decimal("0")) is True
    assert is_suspicious(Decimal("-0.01")) is True
    assert is_suspicious(Decimal("0.31")) is True
    assert is_suspicious(Decimal("0.05")) is False
    assert is_suspicious(None) is False


# ───────────────────────── 连续年数 / 最近分红年（§8.2） ─────────────────────────
def test_consecutive_years_gap_breaks():
    """守护 §8.2：自当前财年向前连续计数，断一年即止。"""
    cells = [
        _cell("a", 2026, 1, "1.0"),
        _cell("b", 2025, 1, "1.0"),
        _cell("c", 2024, 1, "1.0"),
    ]
    assert consecutive_years(cells, 2026) == 3
    # 断年：2024 缺失 → 止于 2025
    gap = [_cell("a", 2026, 1, "1.0"), _cell("c", 2024, 1, "1.0")]
    assert consecutive_years(gap, 2026) == 1


def test_consecutive_years_rejected_excluded():
    """守护 §8.2：REJECTED 不参与连续年计数（近两年停发自然计 0）。"""
    cells = [_cell("a", 2025, 4, "1.0", DividendStatus.REJECTED)]
    assert consecutive_years(cells, 2026) == 0


def test_last_dividend_year_none_and_value():
    """守护 §8.2：最近分红财年取 max；无可计入 → None。"""
    cells = [_cell("a", 2024, 4, "1.0"), _cell("b", 2025, 4, "1.0")]
    assert last_dividend_year(cells) == 2025
    assert last_dividend_year([]) is None


def test_has_recent_dividend_window():
    """守护 §8.2 近两年判定窗口：窗口内/外边界。"""
    inner = [_cell("a", 2025, 4, "1.0")]
    assert has_recent_dividend(inner, current_year=2026, window=2) is True
    outer = [_cell("b", 2023, 4, "1.0")]
    assert has_recent_dividend(outer, current_year=2026, window=2) is False


# ───────────────────────── 反推价格（§9） ─────────────────────────
def test_implied_price_div_zero_and_boundaries():
    """守护 §9：numerator/target_ratio 除零或非法入参 → None。"""
    assert implied_price(Decimal("1.0"), Decimal("0.05")) == Decimal("20.0")
    assert implied_price(None, Decimal("0.05")) is None
    assert implied_price(Decimal("1.0"), None) is None
    assert implied_price(Decimal("1.0"), Decimal("0")) is None
    assert implied_price(Decimal("1.0"), Decimal("-0.5")) is None


# ───────────────────────── 曲线末点 == 快照（§9 一致性契约） ─────────────────────────
def test_compute_yield_at_uses_visible_set():
    """守护 §9：compute_yield_at 用「截至 as_of 可见」记录集；未到的 ex_date 不进入分子。"""
    cells = [
        _cell("past", 2025, 4, "1.0", ex="2025-05-10"),
        _cell("future", 2026, 1, "2.0", ex="2026-12-01"),  # as_of 之后才除权
    ]
    as_of = date(2026, 6, 1)
    res = compute_yield_at(cells, as_of, Decimal("10"), 2026)
    assert res.numerator_per_share == Decimal("1.0")  # future 未可见
    assert tuple(res.ref_div_ids) == ("past",)


def test_curve_end_match_snapshot_when_all_visible():
    """守护 §9 一致性：全部可见时 compute_yield_at == compute_yield（末点==快照）。"""
    cells = [
        _cell("a", 2025, 2, "0.30", ex="2025-07-01"),
        _cell("b", 2025, 1, "0.30", ex="2025-05-01"),
        _cell("c", 2024, 4, "0.30", ex="2025-06-01"),
        _cell("d", 2024, 3, "0.30", ex="2025-04-01"),
    ]
    as_of = date(2026, 1, 1)
    price = Decimal("6.0")
    snap = compute_yield(cells, price, 2026)
    point = compute_yield_at(cells, as_of, price, 2026)
    assert point.mode == snap.mode
    assert point.dividend_yield == snap.dividend_yield
    assert point.numerator_per_share == snap.numerator_per_share


def test_special_uses_announcement_anchor():
    """守护附录 A.6 / §9：SPECIAL 行无 ex_date 时回退公告日作归位锚点。"""
    cells = [
        _cell(
            "sp", 2024, 4, "19.0", ptype=ReportPeriodType.SPECIAL,
            ex=None, ann="2024-12-10",
        ),
    ]
    # 公告日之后可见 → 计入分子
    after = compute_yield_at(cells, date(2024, 12, 11), Decimal("100"), 2025)
    assert after.numerator_per_share == Decimal("19.0")
    # 公告日之前不可见 → 空
    before = compute_yield_at(cells, date(2024, 12, 9), Decimal("100"), 2025)
    assert before.numerator_per_share is None