"""QA(Edward) 第 2 轮回归：D1~D8 独立复核 + 与 HEAD 逐行等价对账。

本文件由 QA **独立编写**，不复用工程师的 harness。HEAD 参考语义直接复刻自：

- ``git show HEAD:backend/app/services/market_data_sync.py`` 的 ``_row_get``；
- ``git show HEAD:backend/app/services/dividend_sync.py`` 的 ``_code_of``；
- ``git show HEAD:backend/app/services/dividend_notice_scan.py`` 公告取码两段
  （先 ``_row_get(r, "代码")``，取不到再 ``_row_get(r, itf.resp_code_field)``）。

命名约定：``F9.1``~``F9.6`` 对应方案 §2.4 的六个消费点。
"""
from __future__ import annotations

import sys
import uuid
from types import SimpleNamespace

import pytest

from app.services.dividend_sync import _code_of as new_code_of
from app.services.market_data_sync import (
    MarketDataSyncService,
    _flatten_dataframe_records,
)
from app.services.response_fields import (
    SLOT_CODE,
    filter_required_rows,
    index_by_slot,
    resolve_fields,
)
from app.services.response_path import PathSyntaxError, row_get


# ───────────────────────── HEAD 参考实现（语义复刻，逐字对齐 HEAD） ─────────────────────────
def head_row_get(row, field):
    """HEAD ``market_data_sync._row_get``：dict 字面 key / 数组行数字下标。"""
    if row is None:
        return None
    if isinstance(row, dict):
        return row.get(field)
    if isinstance(row, (list, tuple)):
        if field and str(field).isdigit():
            idx = int(field)
            return row[idx] if 0 <= idx < len(row) else None
        return None
    return None


def head_code_of(itf, row):
    """HEAD ``dividend_sync._code_of``：候选 ``[resp_code_field, "代码"]``，空值跳过，dict-only。"""
    for field in (itf.resp_code_field, "代码"):
        if not field:
            continue
        val = row.get(field) if isinstance(row, dict) else None
        if val is not None:
            return val
    return None


def head_notice_code(itf, row):
    """HEAD ``dividend_notice_scan`` 取码：先「代码」，取不到再 ``resp_code_field``。"""
    raw = head_row_get(row, "代码")
    if raw is None:
        raw = head_row_get(row, itf.resp_code_field)
    return raw


# ───────────────────────── 现实现：6 消费点取码 ─────────────────────────
def _iface(category_id, resp_code_field, **kw):
    base = dict(
        name="qa-iface",
        category_id=category_id,
        resp_code_field=resp_code_field,
        resp_price_field="price",
        resp_name_field="name",
        resp_exchange_field=None,
        response_parse={},
        response_fields=None,
    )
    base.update(kw)
    return SimpleNamespace(**base)


def _strict_code(itf, row):
    """F9.1/F9.2/F9.3/F9.4 现实现（显式关闭中文兜底）。"""
    f = index_by_slot(
        resolve_fields(itf, include_legacy_code_fallback=False)
    ).get(SLOT_CODE)
    return f.get(row) if f else None


def _loose_code(itf, row):
    """F9.5 ``dividend_sync._code_of`` 现实现。"""
    return new_code_of(itf, row)


def _notice_code(itf, row):
    """F9.6 ``dividend_notice_scan`` 现实现（默认 resolve_fields → cat 分派）。"""
    f = index_by_slot(resolve_fields(itf)).get(SLOT_CODE)
    return f.get(row) if f else None


# 交叉矩阵：category × resp_code_field × 行（D1/D3 要求「不要只用一条反例」）
_CATS = ["1", "2", "3", "4", None]
_CODES = ["code", "代码", "", None]
_ROWS = [
    {"代码": "C", "code": "D"},
    {"代码": "C"},
    {"code": "D"},
    {"代码": None, "code": "D"},
    {"代码": "", "code": "D"},
    {"代码": "C", "code": None},
    {"代码": "C", "code": ""},
    {"代码": None, "code": None},
    {},
    {"0": "Z"},
    ["A", "B"],
]

# 开发库 investment_tracker 现存 13 条接口的真实配置（QA 只读导出，未改动开发库）
_REAL_CONFIGS = [
    ("1", "0"), ("1", "code"), ("1", "symbol"), ("1", "security_CODE"),
    ("1", "0"), ("1", "代码"),
    ("2", "_code"), ("2", "code"), ("2", "code"), ("2", "代码"),
    ("3", "代码"), ("3", "code"),
    ("4", "代码"),
]


def _count_groups(points):
    """统计比对组数（每个消费点 × 配置 × 行）。"""
    return len(points) * len(_ROWS)


# ───────────────────────── D2：strict 路径不得有中文兜底（F9.1~F9.4） ─────────────────────────
def test_f9_1_to_f9_4_strict_matches_head_master_semantics() -> None:
    """全 cat × 全 code × 全行：strict 取码 == HEAD ``resp_code_field or "code"`` 单候选。"""
    diffs = []
    for cat in _CATS:
        for code in _CODES:
            itf = _iface(cat, code)
            head_field = itf.resp_code_field or "code"
            for row in _ROWS:
                old, new = head_row_get(row, head_field), _strict_code(itf, row)
                if old != new:
                    diffs.append((cat, code, row, old, new))
    assert diffs == [], f"strict 路径与 HEAD 主数据取码不等价：{diffs}"


# ───────────────────────── D1/D3：cat=3 分红 / cat=4 公告 候选顺序与 HEAD 等价 ─────────────────────────
def test_d1_d3_cat3_code_of_matches_head() -> None:
    """cat=3：``_code_of`` 候选 ``[配置列(空值跳过), 代码]`` 与 HEAD 逐格一致。"""
    diffs = []
    for code in _CODES:
        itf = _iface("3", code)
        for row in _ROWS:
            old, new = head_code_of(itf, row), _loose_code(itf, row)
            if old != new:
                diffs.append((code, row, old, new))
    assert diffs == [], f"cat=3 _code_of 与 HEAD 不等价：{diffs}"


def test_d1_d3_cat4_notice_matches_head() -> None:
    """cat=4：公告取码「代码」优先，与 HEAD 逐格一致。"""
    diffs = []
    for code in _CODES:
        itf = _iface("4", code)
        for row in _ROWS:
            old, new = head_notice_code(itf, row), _notice_code(itf, row)
            if old != new:
                diffs.append((code, row, old, new))
    assert diffs == [], f"cat=4 公告取码与 HEAD 不等价：{diffs}"


def test_d1_d3_category_dispatch_observed_scope() -> None:
    """记实：``_code_of``/公告取码按 category 分派，故非对应 cat 上会与 HEAD 不同。

    生产不可达：``dividend_sync._resolve_interface`` 强制 cat=3，
    ``dividend_notice_scan._resolve_notice_itf`` 强制 cat=4。
    此处仅**断言隔离面**，防止未来把非 3/4 分类接口接进来而无人发现。
    """
    # cat=4 接口交给 _code_of（本应只有 cat=3 才允许）→ 顺序与 HEAD 相反，会有差异
    itf4 = _iface("4", "code")
    row = {"代码": "C", "code": "D"}
    assert head_code_of(itf4, row) == "D"   # HEAD：配置列优先
    assert _loose_code(itf4, row) == "C"    # 现实现：cat=4 走「代码」优先
    # cat=3 接口交给公告取码 → 与 HEAD 公告相反
    itf3 = _iface("3", "code")
    assert head_notice_code(itf3, row) == "C"      # HEAD 公告：代码优先
    assert _notice_code(itf3, row) == "D"          # 现实现：cat=3 走配置列优先


def test_d1_d3_real_existing_configs_equivalence() -> None:
    """13 条存量真实配置：strict 与 HEAD 主数据取码 0 差异；
    cat=3 的 _code_of、cat=4 的公告取码 0 差异。"""
    diffs = []
    for cat, code in _REAL_CONFIGS:
        itf = _iface(cat, code)
        head_field = itf.resp_code_field or "code"
        for row in _ROWS:
            if head_row_get(row, head_field) != _strict_code(itf, row):
                diffs.append(("strict", cat, code, row))
            if cat == "3" and head_code_of(itf, row) != _loose_code(itf, row):
                diffs.append(("code_of", cat, code, row))
            if cat == "4" and head_notice_code(itf, row) != _notice_code(itf, row):
                diffs.append(("notice", cat, code, row))
    assert diffs == [], f"存量配置不等价：{diffs}"


# ───────────────────────── D2：主数据链路对 cat=3 不得外溢中文兜底 ─────────────────────────
def test_d2_prepare_master_rows_cat3_only_chinese_column_returns_empty() -> None:
    """cat=3、resp_code_field='code'、行只有「代码」列 → 主数据准备必须返回 []（D2）。"""
    itf = _iface("3", "code")
    svc = MarketDataSyncService(None)
    assert svc._prepare_master_rows(itf, [{"代码": "600519", "名称": "贵州茅台"}]) == []


def test_d2_prepare_master_rows_cat3_configured_column_still_works() -> None:
    """cat=3、resp_code_field='code'、行有 'code' 列 → 正常产出（未误伤正常路径）。"""
    itf = _iface("3", "code")
    svc = MarketDataSyncService(None)
    out = svc._prepare_master_rows(itf, [{"code": "600519"}])
    assert len(out) == 1 and out[0]["code"].endswith("600519")


def test_d2_prepare_master_rows_accepts_chinese_configured_column() -> None:
    """存量「东财-分红配送」配置 resp_code_field='代码' → 主数据链路照常取到（非兜底）。"""
    itf = _iface("3", "代码")
    svc = MarketDataSyncService(None)
    out = svc._prepare_master_rows(itf, [{"代码": "600519"}])
    assert len(out) == 1 and out[0]["code"].endswith("600519")


# ───────────────────────── D4：row_get 空串回退 HEAD 语义；其余非法语法仍抛错 ─────────────────────────
def test_d4_row_get_empty_field_returns_none_like_head() -> None:
    assert row_get({"code": "sh600000"}, "") is None
    assert row_get(["600000"], "") is None
    assert row_get(None, "") is None


def test_d4_structural_invalid_syntax_still_raises() -> None:
    for bad in ["[", "items[0", "items[x]", ".", ".."]:
        with pytest.raises(PathSyntaxError):
            row_get({"a": 1}, bad)


def test_d4_double_dot_lenient_characterization() -> None:
    """记实（规格未定义）：``a..b`` 被解析为 a→b（空段静默忽略），**不抛错**。

    规格只要求「未闭合 [ / 非数字下标」等结构错误抛错，未定义空段；记为观察项，
    不判定为缺陷，但提醒：若期望 ``a..b`` 非法，需补 parse_source 规则。
    """
    assert row_get({"a": {"b": 7}, "a..b": "literal"}, "a..b") == 7


# ───────────────────────── D6：MultiIndex 列显式拒绝 + 普通 DataFrame 零变化 ─────────────────────────
class _DF:
    """含 to_dict('records') 的 DataFrame 替身（走 _flatten_dataframe_records 分支）。"""

    def __init__(self, records):
        self._records = records
        self.empty = not records

    def to_dict(self, orient="records"):
        assert orient == "records"
        return list(self._records)


def test_d6_multiindex_rejected_readable_chinese() -> None:
    with pytest.raises(ValueError) as ei:
        _flatten_dataframe_records(_DF([{("代码", "二级"): "600000", "price": "12.34"}]))
    msg = str(ei.value)
    assert "MultiIndex" in msg
    assert any("\u4e00" <= ch <= "\u9fff" for ch in msg), "错误信息应含中文说明"
    assert isinstance(ei.value, ValueError)


def test_d6_scalar_columns_zero_behavior_change() -> None:
    recs = [{"code": "600000", "price": "12.34"}, {"code": "000001", "price": "1.00"}]
    assert _flatten_dataframe_records(_DF(recs)) == recs


class _MultiIndexAkShare:
    """mock akshare：顶层函数返回含 tuple 列名的 DataFrame。"""

    def stock_zh_a_spot(self, **kwargs):
        return _DF([{("代码", "二级"): "600000", "price": "12.34"}])


@pytest.mark.asyncio
async def test_d6_multiindex_via_fetch_sdk_raw(session, monkeypatch) -> None:
    """走 ``_fetch_sdk_raw`` 全链路：MultiIndex → ValueError（可读中文），不被吞。"""
    from app.models.enums import QuoteProviderAccessMethod
    from app.models.interface_category import InterfaceCategory
    from app.models.quote_interface import QuoteInterface
    from app.models.quote_provider import SecuritiesDataProvider

    provider = SecuritiesDataProvider(
        id=str(uuid.uuid4()), name="QA-AK", access_method=QuoteProviderAccessMethod.SDK,
        config={"sdk_name": "akshare", "sdk_func": "stock_zh_a_spot"}, enabled=True,
    )
    cat = InterfaceCategory(id=str(uuid.uuid4()), label="QA行情")
    session.add_all([provider, cat])
    await session.flush()
    itf = QuoteInterface(
        id=str(uuid.uuid4()), provider_id=provider.id, category_id=cat.id,
        name="qa-ak", enabled=True, priority=1,
        resp_code_field="code", resp_price_field="price", params={},
    )
    session.add(itf)
    await session.commit()
    monkeypatch.setitem(sys.modules, "akshare", _MultiIndexAkShare())

    svc = MarketDataSyncService(session)
    with pytest.raises(ValueError, match="MultiIndex"):
        await svc._fetch_sdk_raw(itf, {}, ["600000"])


# ───────────────────────── D7：required 整行丢弃 + 计数 ─────────────────────────
def test_d7_filter_required_rows_drops_whole_row() -> None:
    from app.services.response_fields import compile_spec

    fields = [
        compile_spec({"key": "code", "slot": "code", "source": "code", "required": True}),
        compile_spec({"key": "price", "slot": "price", "source": "price"}),
    ]
    rows = [{"code": "a", "price": "1"}, {"price": "2"}, {"code": "b"}]
    kept, dropped = filter_required_rows(fields, rows)
    assert dropped == 1
    assert [r.get("code") for r in kept] == ["a", "b"]


def test_d7_no_required_is_noop() -> None:
    from app.services.response_fields import compile_spec

    fields = [compile_spec({"key": "code", "slot": "code", "source": "code"})]
    rows = [{"x": 1}, {"y": 2}]
    kept, dropped = filter_required_rows(fields, rows)
    assert dropped == 0 and kept is not rows and kept == rows


@pytest.mark.asyncio
async def test_d7_partial_drop_does_not_count_failure(session) -> None:
    """部分丢行：只 WARNING，不进失败计数。"""
    from app.models.enums import QuoteProviderAccessMethod

    itf = await _seed_iface(session, QuoteProviderAccessMethod.SDK)
    svc = MarketDataSyncService(session)
    await svc._mark_success(itf.id)
    await svc._note_required_drops(itf, dropped=2, total=5)  # 部分
    await session.refresh(itf)
    assert itf.consecutive_failures == 0


@pytest.mark.asyncio
async def test_d7_full_drop_counts_failure_but_escalation_unreachable(session) -> None:
    """整批丢行：确实 ++失败计数；但前置 ``_mark_success`` 复位使其跨轮无法累积到阈值。

    这是 characterization：记录 D7「整批丢弃复用 _mark_failure」的**实际效果**——
    每轮 raw 拉取成功先复位为 0，再 ++ 得 1，故连续 3 轮仍为 1，永远到不了
    ``FAILURE_THRESHOLD=3``，站内信不触发（仅 WARNING 日志生效）。
    """
    from app.models.enums import QuoteProviderAccessMethod

    itf = await _seed_iface(session, QuoteProviderAccessMethod.SDK)
    svc = MarketDataSyncService(session)
    for _ in range(3):
        await svc._mark_success(itf.id)              # 模拟 raw 拉取成功（_call_interface_raw）
        await svc._note_required_drops(itf, dropped=5, total=5)
    await session.refresh(itf)
    assert itf.consecutive_failures >= 1             # 整批丢弃确实计了失败
    assert itf.consecutive_failures < 3              # 但无法累积到告警阈值
    assert itf.alerted is False


async def _seed_iface(session, access_method):
    from app.models.interface_category import InterfaceCategory
    from app.models.quote_interface import QuoteInterface
    from app.models.quote_provider import SecuritiesDataProvider

    provider = SecuritiesDataProvider(
        id=str(uuid.uuid4()), name="QA-FAIL", access_method=access_method,
        config={"sdk_name": "akshare", "sdk_func": "x"}, enabled=True,
    )
    cat = InterfaceCategory(id=str(uuid.uuid4()), label="QA失败计数")
    session.add_all([provider, cat])
    await session.flush()
    itf = QuoteInterface(
        id=str(uuid.uuid4()), provider_id=provider.id, category_id=cat.id,
        name="qa-fail", enabled=True, priority=1,
        resp_code_field="code", resp_price_field="price", params={},
    )
    session.add(itf)
    await session.commit()
    return itf
