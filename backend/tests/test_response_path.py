"""响应字段路径 DSL 单测（方案 §4.2 / 边界 1/2）：纯逻辑，无 DB。

覆盖：顶层 key / 数组位置下标 / ``a.b`` / ``items[0].code`` / ``a\\.b`` 字面含点 key /
非法语法；以及 ``row_get`` 对 dict 字面 ``"0"`` 与数组下标 ``0`` 的历史语义。
"""
from __future__ import annotations

import pytest

from app.services.response_path import (
    PathSegment,
    PathSyntaxError,
    compile_source,
    parse_source,
    row_get,
)


# ───────────────────────── parse_source ─────────────────────────
def test_parse_simple_key() -> None:
    assert parse_source("code") == (PathSegment("key", "code"),)


def test_parse_digit_key_single_segment() -> None:
    # 单段纯数字解析为 key（dict 字面 / 数组下标的历史双语义在 getter 内处理）
    assert parse_source("0") == (PathSegment("key", "0"),)


def test_parse_dotted_path() -> None:
    assert parse_source("data.last") == (
        PathSegment("key", "data"),
        PathSegment("key", "last"),
    )


def test_parse_bracket_index() -> None:
    assert parse_source("items[0].code") == (
        PathSegment("key", "items"),
        PathSegment("index", 0),
        PathSegment("key", "code"),
    )


def test_parse_leading_bracket_index() -> None:
    assert parse_source("[2].price") == (
        PathSegment("index", 2),
        PathSegment("key", "price"),
    )


def test_parse_escaped_dot_key() -> None:
    # a\.b → 字面含点 key（akshare 列名如 2024.06）
    assert parse_source("a\\.b") == (PathSegment("key", "a.b"),)
    assert parse_source("2024\\.06") == (PathSegment("key", "2024.06"),)


def test_parse_escaped_backslash() -> None:
    assert parse_source("a\\\\b") == (PathSegment("key", "a\\b"),)


def test_parse_empty_source_raises() -> None:
    with pytest.raises(PathSyntaxError):
        parse_source("")


def test_parse_unclosed_bracket_raises() -> None:
    with pytest.raises(PathSyntaxError):
        parse_source("items[0.code")


def test_parse_non_digit_index_raises() -> None:
    with pytest.raises(PathSyntaxError):
        parse_source("items[x].code")


def test_parse_unicode_superscript_index_raises_path_syntax_error() -> None:
    # D2："²".isdigit() 为 True 但 int("²") 抛裸 ValueError；必须收敛为 PathSyntaxError
    # （保存接口 400 而非 500）
    with pytest.raises(PathSyntaxError):
        parse_source("a[²]")
    with pytest.raises(PathSyntaxError):
        row_get({"a": [1, 2]}, "a[²]")


def test_parse_arabic_indic_digit_index_keeps_working() -> None:
    # D2 约束："١"（阿拉伯-印度数字 1）int() 可解析，行为零变化
    assert parse_source("a[١]") == (PathSegment("key", "a"), PathSegment("index", 1))


# ───────────────────────── row_get：dict 行 ─────────────────────────
def test_row_get_dict_top_key() -> None:
    assert row_get({"code": "sh600000", "price": "10.5"}, "code") == "sh600000"


def test_row_get_dict_literal_digit_key() -> None:
    # dict 行的字面 key "0" 保持现状（边界 2）
    assert row_get({"0": "a", "1": "b"}, "0") == "a"


def test_row_get_dict_nested_path() -> None:
    row = {"data": {"last": "10.5"}}
    assert row_get(row, "data.last") == "10.5"


def test_row_get_dict_literal_dotted_key_via_escape() -> None:
    row = {"2024.06": "12.3"}
    assert row_get(row, "2024\\.06") == "12.3"


# ───────────────────────── row_get：数组行 ─────────────────────────
def test_row_get_list_positional_digit() -> None:
    row = ["600000", "浦发银行", "10.50"]
    assert row_get(row, "0") == "600000"
    assert row_get(row, "2") == "10.50"


def test_row_get_list_out_of_range() -> None:
    assert row_get(["a"], "3") is None


def test_row_get_list_non_digit_returns_none() -> None:
    # 数组行用字段名（非下标）取不到（现状语义）
    assert row_get(["600000"], "price") is None


def test_row_get_nested_bracket_index() -> None:
    row = {"items": [{"code": "sh600000"}, {"code": "sz000001"}]}
    assert row_get(row, "items[1].code") == "sz000001"
    assert row_get(row, "items[0].code") == "sh600000"


def test_row_get_index_on_missing_or_none() -> None:
    assert row_get(None, "code") is None
    assert row_get({"a": None}, "a.b") is None


def test_row_get_non_string_field() -> None:
    # 历史兼容：非字符串 field 在 dict 行按原值取 key、数组行按 int 下标
    assert row_get({1: "one"}, 1) == "one"
    assert row_get(["x", "y"], 1) == "y"


def test_row_get_empty_field_returns_none() -> None:
    # D4：空字符串 field 按 HEAD 语义返回 None，不得当非法路径抛 PathSyntaxError
    assert row_get({"code": "sh600000"}, "") is None
    assert row_get(["600000"], "") is None
    assert row_get(None, "") is None


def test_row_get_invalid_syntax_still_raises() -> None:
    # D4：仅空串豁免；其余非法语法仍照旧抛错
    with pytest.raises(PathSyntaxError):
        row_get({"a": 1}, "items[0")


def test_compile_source_cached() -> None:
    assert compile_source("code") is compile_source("code")
