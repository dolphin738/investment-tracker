"""response_fields 核心单测（方案 §4/§5/§6）：纯逻辑，无 DB。

覆盖：旧列合成（含中文列名兜底）、response_fields 编译、index_by_slot、
静态校验、分类契约、旧列折叠 / 派生、逐槽位命中率、契约 schema 载荷。
"""
from __future__ import annotations

from types import SimpleNamespace

from app.services.response_fields import (
    QUOTE_CAT_ID,
    SLOT_CODE,
    SLOT_DATE,
    SLOT_EXCHANGE,
    SLOT_NAME,
    SLOT_PRICE,
    build_field_schema,
    check_slot_contract,
    compute_slot_hit_rates,
    derive_legacy_columns,
    fold_legacy_columns,
    index_by_key,
    index_by_slot,
    resolve_fields,
    validate_response_fields,
)


def _legacy_iface(**overrides):
    """最小接口桩：旧 4 列 + response_parse（无 response_fields）。"""
    base = {
        "resp_code_field": "code",
        "resp_price_field": "price",
        "resp_name_field": "name",
        "resp_exchange_field": None,
        "response_parse": {},
    }
    base.update(overrides)
    return SimpleNamespace(**base)


# ───────────────────────── 旧列合成（resolve_fields） ─────────────────────────
def test_synthesize_from_legacy_columns() -> None:
    itf = _legacy_iface(
        resp_exchange_field="market",
        response_parse={"resp_date_field": "trade_date"},
    )
    fields = resolve_fields(itf)
    by_slot = index_by_slot(fields)
    assert set(by_slot) == {SLOT_CODE, SLOT_NAME, SLOT_PRICE, SLOT_EXCHANGE, SLOT_DATE}
    row = {"code": "sh600000", "name": "浦发银行", "price": "10.5",
           "market": "SH", "trade_date": "2024-06-03"}
    assert by_slot[SLOT_CODE].get(row) == "sh600000"
    assert by_slot[SLOT_NAME].get(row) == "浦发银行"
    assert by_slot[SLOT_PRICE].get(row) == "10.5"
    assert by_slot[SLOT_EXCHANGE].get(row) == "SH"
    assert by_slot[SLOT_DATE].get(row) == "2024-06-03"


def test_synthesize_omits_optional_when_unset() -> None:
    fields = resolve_fields(_legacy_iface())
    by_slot = index_by_slot(fields)
    assert SLOT_EXCHANGE not in by_slot  # resp_exchange_field 为空
    assert SLOT_DATE not in by_slot      # 未配 resp_date_field


def test_synthesize_array_row_positional() -> None:
    itf = _legacy_iface(resp_code_field="0", resp_price_field="2")
    by_slot = index_by_slot(resolve_fields(itf))
    assert by_slot[SLOT_CODE].get(["600000", "浦发银行", "10.50"]) == "600000"
    assert by_slot[SLOT_PRICE].get(["600000", "浦发银行", "10.50"]) == "10.50"


def test_synthesize_code_chinese_fallback_for_dividend_notice() -> None:
    """分红/公告用途：resp_code_field 配错（'code'）时回退中文列名「代码」（F4）。"""
    by_slot = index_by_slot(
        resolve_fields(_legacy_iface(resp_code_field="code", category_id="3"))
    )
    assert by_slot[SLOT_CODE].get({"代码": "600519"}) == "600519"
    by_slot4 = index_by_slot(
        resolve_fields(_legacy_iface(resp_code_field="code", category_id="4"))
    )
    assert by_slot4[SLOT_CODE].get({"代码": "600519"}) == "600519"


def test_synthesize_no_chinese_fallback_for_master_or_quote() -> None:
    """主数据/行情用途无中文列名兜底（否则会掩盖列名错配，须如实取空）。"""
    for cid in ("1", "2", None):
        by_slot = index_by_slot(
            resolve_fields(_legacy_iface(resp_code_field="code", category_id=cid))
        )
        assert by_slot[SLOT_CODE].get({"代码": "600519"}) is None


def test_synthesize_stub_without_response_fields_attr() -> None:
    """无 response_fields 属性的接口桩也可解析（getattr 容错）。"""
    itf = SimpleNamespace(
        resp_code_field="code", resp_name_field="name", resp_exchange_field=None
    )
    by_slot = index_by_slot(resolve_fields(itf))
    assert by_slot[SLOT_CODE].get({"code": "000001"}) == "000001"


# ───────────────────────── code 槽候选顺序（D1/D2/D3，按 category 分派） ─────────────────────────
def test_code_candidate_order_notice_chinese_first() -> None:
    """公告用途（cat=4）：中文列名「代码」优先（与 HEAD dividend_notice_scan 等价）。"""
    field = index_by_slot(
        resolve_fields(_legacy_iface(resp_code_field="code", category_id="4"))
    )[SLOT_CODE]
    assert field.get({"代码": "600519", "code": "999999"}) == "600519"


def test_code_candidate_order_dividend_config_first() -> None:
    """分红用途（cat=3）：配置列优先（与 HEAD dividend_sync._code_of 等价）。"""
    field = index_by_slot(
        resolve_fields(_legacy_iface(resp_code_field="code", category_id="3"))
    )[SLOT_CODE]
    assert field.get({"代码": "600519", "code": "999999"}) == "999999"


def test_code_candidate_order_dividend_falsy_config_skips_to_chinese() -> None:
    """分红用途：resp_code_field 为空 → 跳过空值只试「代码」（HEAD _code_of 语义）。"""
    field = index_by_slot(
        resolve_fields(_legacy_iface(resp_code_field="", category_id="3"))
    )[SLOT_CODE]
    assert field.get({"code": "X", "代码": "Y"}) == "Y"


def test_resolve_fields_strict_disables_chinese_fallback() -> None:
    """主数据/行情/试调链路显式关闭兜底：cat=3 也不得多取「代码」列（D2）。"""
    itf = _legacy_iface(resp_code_field="code", category_id="3")
    row = {"代码": "600519"}
    loose = index_by_slot(resolve_fields(itf))[SLOT_CODE]
    strict = index_by_slot(
        resolve_fields(itf, include_legacy_code_fallback=False)
    )[SLOT_CODE]
    assert loose.get(row) == "600519"   # 分红记录取码：兜底生效
    assert strict.get(row) is None      # 主数据链路：禁用兜底


# ───────────────────────── required 过滤（边界 6 / D7） ─────────────────────────
def test_filter_required_rows_drops_rows_missing_required_slot() -> None:
    from app.services.response_fields import compile_spec, filter_required_rows

    fields = [
        compile_spec({"key": "code", "slot": "code", "source": "code", "required": True}),
        compile_spec({"key": "price", "slot": "price", "source": "price"}),
    ]
    rows = [
        {"code": "sh600000", "price": "10"},
        {"price": "9"},                        # code 缺失（required）→ 整行丢弃
        {"code": "sz000001", "price": None},   # price 非 required → 保留
    ]
    kept, dropped = filter_required_rows(fields, rows)
    assert dropped == 1
    assert len(kept) == 2
    assert kept[0]["code"] == "sh600000"


def test_filter_required_rows_noop_without_required() -> None:
    from app.services.response_fields import compile_spec, filter_required_rows

    fields = [compile_spec({"key": "code", "slot": "code", "source": "code"})]
    rows = [{"code": "a"}, {"other": "b"}]
    kept, dropped = filter_required_rows(fields, rows)
    assert dropped == 0
    assert kept == rows


# ───────────────────────── response_fields 路径 ─────────────────────────
def test_resolve_prefers_response_fields_over_legacy() -> None:
    itf = SimpleNamespace(
        response_fields=[
            {"key": "code", "slot": "code", "source": "secu_code"},
            {"key": "price", "slot": "price", "source": "data.last", "type": "decimal"},
            {"key": "notice_title", "source": "title"},  # 展示字段（无 slot）
        ],
        resp_code_field="code",  # 旧列应被忽略
        response_parse={},
    )
    by_slot = index_by_slot(resolve_fields(itf))
    by_key = index_by_key(resolve_fields(itf))
    assert by_slot[SLOT_CODE].get({"secu_code": "sh600000"}) == "sh600000"
    assert by_slot[SLOT_PRICE].get({"data": {"last": "9.9"}}) == "9.9"
    assert SLOT_NAME not in by_slot
    assert "notice_title" in by_key  # 展示字段在 key 索引、不在 slot 索引


def test_resolve_empty_list_falls_back_to_legacy() -> None:
    itf = _legacy_iface(response_fields=[])
    by_slot = index_by_slot(resolve_fields(itf))
    assert SLOT_CODE in by_slot  # 空列表 → 合成旧列


# ───────────────────────── 静态校验 ─────────────────────────
def test_validate_ok() -> None:
    fields = [
        {"key": "code", "slot": "code", "source": "code"},
        {"key": "price", "slot": "price", "source": "data.last", "type": "decimal", "scale": 2},
        {"key": "notice_title", "source": "title", "type": "string", "unit": "none"},
    ]
    assert validate_response_fields(fields) == []


def test_validate_none_is_ok() -> None:
    assert validate_response_fields(None) == []


def test_validate_not_list() -> None:
    assert validate_response_fields({"a": 1}) == ["response_fields 必须是数组"]


def test_validate_bad_key_and_duplicate() -> None:
    errs = validate_response_fields([
        {"key": "Bad", "source": "a"},
        {"key": "code", "source": "b"},
        {"key": "code", "source": "c"},
    ])
    assert any("key 非法" in e for e in errs)
    assert any("key 重复" in e for e in errs)


def test_validate_underscore_source_allowed() -> None:
    # 边界 7：text_split 注入的特殊键 _code 作为 **source** 必须合法
    assert validate_response_fields(
        [{"key": "code", "slot": "code", "source": "_code"}]
    ) == []


def test_validate_key_must_start_with_lowercase_letter() -> None:
    # key 正则显式要求首字符为小写字母（^[a-z][a-z0-9_]{0,63}$）：
    # 故 key="_code" 非法（方案 §4 括注「_code 合法」与正则冲突，以正则为唯一规格）
    errs = validate_response_fields([{"key": "_code", "source": "a"}])
    assert any("key 非法" in e for e in errs)


def test_validate_duplicate_slot() -> None:
    errs = validate_response_fields([
        {"key": "code", "slot": "code", "source": "a"},
        {"key": "code2", "slot": "code", "source": "b"},
    ])
    assert any("slot 重复" in e for e in errs)


def test_validate_unknown_slot() -> None:
    errs = validate_response_fields([{"key": "x", "slot": "open", "source": "a"}])
    assert any("slot 非法" in e for e in errs)


def test_validate_source_empty_and_too_deep() -> None:
    errs = validate_response_fields([
        {"key": "a", "source": ""},
        {"key": "b", "source": "a.b.c.d.e.f"},  # 6 段 > 5
    ])
    assert any("缺少 source" in e for e in errs)
    assert any("段数" in e for e in errs)


def test_validate_source_bad_syntax() -> None:
    errs = validate_response_fields([{"key": "a", "source": "items[0"}])
    assert any("source 路径非法" in e for e in errs)


def test_validate_scale_rules() -> None:
    # scale 仅 decimal
    assert any("仅 decimal" in e for e in validate_response_fields(
        [{"key": "a", "source": "a", "type": "string", "scale": 2}]
    ))
    # 越界
    assert any("scale 非法" in e for e in validate_response_fields(
        [{"key": "a", "source": "a", "type": "decimal", "scale": 9}]
    ))
    # 合法
    assert validate_response_fields(
        [{"key": "a", "source": "a", "type": "decimal", "scale": 2}]
    ) == []


def test_validate_type_and_unit_whitelist() -> None:
    errs = validate_response_fields([
        {"key": "a", "source": "a", "type": "float"},
        {"key": "b", "source": "b", "unit": "usd"},
    ])
    assert any("type 非法" in e for e in errs)
    assert any("unit 非法" in e for e in errs)


# ───────────────────────── 分类契约 ─────────────────────────
def test_contract_quote_requires_code_price_date() -> None:
    fields = [{"key": "code", "slot": "code", "source": "code"}]
    errs = check_slot_contract(fields, QUOTE_CAT_ID)
    assert any("price" in e and "date" in e for e in errs)


def test_contract_quote_ok() -> None:
    fields = [
        {"key": "code", "slot": "code", "source": "code"},
        {"key": "price", "slot": "price", "source": "price"},
        {"key": "date", "slot": "date", "source": "date"},
    ]
    assert check_slot_contract(fields, QUOTE_CAT_ID) == []


def test_contract_master_list_requires_code() -> None:
    assert check_slot_contract([], "1") != []
    assert check_slot_contract([{"key": "code", "slot": "code", "source": "0"}], "1") == []


def test_contract_display_category_and_none_have_no_contract() -> None:
    # 用户 CRUD 的展示分类（随机 id）无同步用途 → 无契约
    assert check_slot_contract([], "some-display-category") == []
    assert check_slot_contract([], None) == []


# ───────────────────────── 折叠 / 派生 ─────────────────────────
def test_fold_legacy_columns_deterministic() -> None:
    folded = fold_legacy_columns(
        resp_code_field="0",
        resp_price_field="2",
        resp_name_field="1",
        resp_exchange_field="market",
        response_parse={"resp_date_field": "trade_date"},
    )
    assert [f["slot"] for f in folded] == ["code", "name", "price", "exchange", "date"]
    assert folded[0] == {"key": "code", "slot": "code", "source": "0",
                         "type": "string", "required": False}
    assert folded[2]["type"] == "decimal"
    assert folded[4]["type"] == "date"


def test_fold_legacy_columns_defaults_for_unspecified() -> None:
    """code/name/price 始终产出且取旧列模型默认值（保持读侧等价）；exchange/date 缺省不产出。"""
    folded = fold_legacy_columns(resp_code_field="0")
    by_key = {f["key"]: f for f in folded}
    assert set(by_key) == {"code", "name", "price"}
    assert by_key["code"]["source"] == "0"
    assert by_key["name"]["source"] == "name"   # 旧列默认
    assert by_key["price"]["source"] == "price"


def test_derive_legacy_columns() -> None:
    fields = [
        {"key": "code", "slot": "code", "source": "secu_code"},
        {"key": "price", "slot": "price", "source": "data.last"},
        {"key": "date", "slot": "date", "source": "trade_date"},
        {"key": "title", "source": "title"},  # 展示字段不派生
    ]
    derived = derive_legacy_columns(fields)
    assert derived["resp_code_field"] == "secu_code"
    assert derived["resp_price_field"] == "data.last"
    assert derived["resp_date_field"] == "trade_date"
    assert "resp_name_field" not in derived  # 未配 name 槽 → 不出现（不写 NULL）


def test_fold_legacy_columns_f4_placeholder_for_dividend_notice() -> None:
    """分红/公告折叠：遗留占位 'code' / 未配置 → 收敛为中文列名「代码」（F4）。"""
    for cid in ("3", "4"):
        by_key = {f["key"]: f for f in fold_legacy_columns(category_id=cid)}
        assert by_key["code"]["source"] == "代码"
        by_key2 = {f["key"]: f for f in fold_legacy_columns(
            category_id=cid, resp_code_field="code")}
        assert by_key2["code"]["source"] == "代码"
        by_key3 = {f["key"]: f for f in fold_legacy_columns(
            category_id=cid, resp_code_field="代码")}
        assert by_key3["code"]["source"] == "代码"
    # 主数据/行情用途不受影响（保持 'code'）
    assert {f["key"]: f for f in fold_legacy_columns(category_id="1")}["code"]["source"] == "code"


def test_fold_then_derive_roundtrip() -> None:
    folded = fold_legacy_columns(
        resp_code_field="代码", resp_price_field="收盘"
    )
    derived = derive_legacy_columns(folded)
    assert derived["resp_code_field"] == "代码"
    assert derived["resp_price_field"] == "收盘"


# ───────────────────────── 命中率 / 契约 schema ─────────────────────────
def test_compute_slot_hit_rates() -> None:
    itf = _legacy_iface()
    fields = resolve_fields(itf)
    rows = [
        {"code": "sh600000", "price": "10.5"},
        {"code": "sz000001"},  # price 缺失
        {"price": "9.9"},      # code 缺失
    ]
    hits = {h["slot"]: h for h in compute_slot_hit_rates(fields, rows)}
    assert hits[SLOT_CODE]["hit"] == 2
    assert hits[SLOT_CODE]["missing"] == 1
    assert hits[SLOT_CODE]["sample"] == "sh600000"
    assert hits[SLOT_PRICE]["hit"] == 2
    assert hits[SLOT_PRICE]["missing"] == 1


def test_compute_slot_hit_rates_skips_display_fields() -> None:
    itf = SimpleNamespace(response_fields=[{"key": "title", "source": "title"}],
                          response_parse={})
    assert compute_slot_hit_rates(resolve_fields(itf), [{"title": "x"}]) == []


def test_build_field_schema_shape() -> None:
    schema = build_field_schema()
    assert set(schema) == {"slots", "types", "units", "contracts"}
    assert {s["value"] for s in schema["slots"]} == {
        SLOT_CODE, SLOT_NAME, SLOT_EXCHANGE, SLOT_PRICE, SLOT_DATE
    }
    code_slot = next(s for s in schema["slots"] if s["value"] == SLOT_CODE)
    assert set(code_slot["requiredFor"]) == {"1", "2", "3", "4"}
    assert set(schema["contracts"][QUOTE_CAT_ID]["required"]) == {
        SLOT_CODE, SLOT_PRICE, SLOT_DATE
    }
    assert "decimal" in schema["types"]
    assert "yuan" in schema["units"]
