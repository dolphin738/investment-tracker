"""响应字段配置核心（纯逻辑，无 IO / 无 DB / 无框架依赖）。

承载方案 §4/§5：slot 闭集白名单、按同步用途的分类契约、**唯一读入口**
``resolve_fields()``（response_fields 非空 → 以其为准；为空 → 由旧 4 列 +
``response_parse.resp_date_field`` 确定性合成，并对分红/公告用途追加中文列名兜底 F4），
以及 Expand 双写所需的旧列折叠 / 派生与契约端点载荷。路径解析与 ``CompiledField``
见 ``response_path``；本包只做字段语义与校验编排。

本包为「纯位移拆分」：逻辑子模块见 ``_constants`` / ``legacy`` / ``indexing`` /
``validation`` / ``legacy_columns``，本文件作为门面，重导出全部原有公开符号
（含 ``compile_spec`` / ``DEFAULT_TYPE`` / ``DEFAULT_UNIT`` 等被消费方直接 import 的名称），
保证 ``from app.services.response_fields import X`` 与 ``response_fields.X`` 两种引用
方式均保持不变（零行为变更）。
"""

from __future__ import annotations

from app.services.response_path import DEFAULT_TYPE, DEFAULT_UNIT

from ._constants import (
    COMPILED,
    KEY_PATTERN,
    MASTER_LIST_CAT_ID,
    NOTICE_CAT_ID,
    QUOTE_CAT_ID,
    DIVIDEND_LIST_CAT_ID,
    MAX_SOURCE_SEGMENTS,
    SCALE_MAX,
    SCALE_MIN,
    SLOT_CODE,
    SLOT_CONTRACT,
    SLOT_DATE,
    SLOT_EXCHANGE,
    SLOT_LABELS,
    SLOT_NAME,
    SLOT_PRICE,
    SLOT_WHITELIST,
    TYPE_WHITELIST,
    UNIT_WHITELIST,
)
from .indexing import compute_slot_hit_rates, index_by_key, index_by_slot
from .legacy import _code_candidates, _code_field, _synthesize_legacy, code_candidates_for, resolve_fields
from .legacy_columns import build_field_schema, derive_legacy_columns, fold_legacy_columns
from .validation import check_slot_contract, filter_required_rows, validate_response_fields

# 路径解析能力（被消费方直接 import，见 test_response_fields.py / test_qa_round2_regression.py）
from app.services.response_path import compile_spec  # noqa: F401

__all__ = [
    # 常量 / 白名单
    "SLOT_CODE", "SLOT_NAME", "SLOT_EXCHANGE", "SLOT_PRICE", "SLOT_DATE",
    "SLOT_WHITELIST", "SLOT_LABELS", "TYPE_WHITELIST", "UNIT_WHITELIST",
    "DEFAULT_TYPE", "DEFAULT_UNIT", "KEY_PATTERN", "SCALE_MIN", "SCALE_MAX",
    "MAX_SOURCE_SEGMENTS", "SLOT_CONTRACT", "COMPILED",
    "MASTER_LIST_CAT_ID", "QUOTE_CAT_ID", "DIVIDEND_LIST_CAT_ID", "NOTICE_CAT_ID",
    # 编译 / 读入口
    "compile_spec", "resolve_fields", "index_by_slot", "index_by_key",
    "compute_slot_hit_rates", "filter_required_rows", "code_candidates_for",
    "validate_response_fields", "check_slot_contract",
    "fold_legacy_columns", "derive_legacy_columns", "build_field_schema",
    # 内部辅助（供测试 / 跨模块调用）
    "_code_candidates", "_code_field", "_synthesize_legacy",
]
