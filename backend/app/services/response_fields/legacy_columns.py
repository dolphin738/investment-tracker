"""旧列折叠 / 派生（Expand 双写）+ 契约单源供给。"""

from __future__ import annotations

from typing import Any, Optional

from app.services.response_path import DEFAULT_TYPE, compile_spec

from ._constants import (
    SLOT_CODE,
    SLOT_DATE,
    SLOT_EXCHANGE,
    SLOT_LABELS,
    SLOT_NAME,
    SLOT_PRICE,
    SLOT_WHITELIST,
    SLOT_CONTRACT,
    TYPE_WHITELIST,
    UNIT_WHITELIST,
    _FALLBACK_CODE_FIELD,
    _CODE_FALLBACK_CATEGORIES,
    _LEGACY_SLOT_COLUMNS,
)
from .indexing import index_by_slot

__all__ = ["fold_legacy_columns", "derive_legacy_columns", "build_field_schema"]


def fold_legacy_columns(
    *,
    category_id: Optional[str] = None,
    resp_code_field: Optional[str] = None,
    resp_price_field: Optional[str] = None,
    resp_name_field: Optional[str] = None,
    resp_exchange_field: Optional[str] = None,
    response_parse: Optional[dict[str, Any]] = None,
) -> list[dict[str, Any]]:
    """老前端仅提交旧列时，**确定性**折成 ``response_fields`` 落库。

    ``code`` / ``name`` / ``price`` 三槽始终产出，且取旧列的**模型默认值**
    （``code`` / ``name`` / ``price``）——与旧 4 列读侧语义（``itf.resp_*_field or 默认``）
    完全一致，避免折叠出「缺槽」的字段表导致读侧退化；``exchange`` / ``date`` 仅在显式
    提供时产出（与旧列「缺失即不配置」一致）。

    分红 / 公告用途（``category_id`` ∈ {3,4}）额外做 F4 收敛：旧列遗留占位 ``"code"``
    （源站无此列）替换为中文列名兜底 ``"代码"``，与合成分支的兜底语义保持一致。
    """
    rp = response_parse or {}
    code_source = resp_code_field or "code"
    if str(category_id) in _CODE_FALLBACK_CATEGORIES and code_source == "code":
        code_source = _FALLBACK_CODE_FIELD
    fields: list[dict[str, Any]] = [
        {"key": SLOT_CODE, "slot": SLOT_CODE, "source": code_source,
         "type": DEFAULT_TYPE, "required": False},
        {"key": SLOT_NAME, "slot": SLOT_NAME, "source": resp_name_field or "name",
         "type": DEFAULT_TYPE},
        {"key": SLOT_PRICE, "slot": SLOT_PRICE, "source": resp_price_field or "price",
         "type": "decimal"},
    ]
    if resp_exchange_field:
        fields.append({"key": SLOT_EXCHANGE, "slot": SLOT_EXCHANGE,
                       "source": resp_exchange_field, "type": DEFAULT_TYPE})
    date_field = rp.get("resp_date_field")
    if date_field:
        fields.append({"key": SLOT_DATE, "slot": SLOT_DATE, "source": str(date_field),
                       "type": "date"})
    return fields


def derive_legacy_columns(fields: list[dict[str, Any]]) -> dict[str, str]:
    """``response_fields`` → 旧列镜像（双写用，供回滚）。

    返回出现的旧列键值（``resp_code_field`` 等 + ``resp_date_field``，日期归
    ``response_parse``）；缺省项不出现，避免把 NOT NULL 列写成 NULL。
    """
    compiled = index_by_slot(
        [compile_spec(spec) for spec in fields if isinstance(spec, dict)]
    )
    out: dict[str, str] = {}
    for slot, column in _LEGACY_SLOT_COLUMNS.items():
        field = compiled.get(slot)
        if field is not None:
            out[column] = field.source
    date_field = compiled.get(SLOT_DATE)
    if date_field is not None:
        out["resp_date_field"] = date_field.source
    return out


def build_field_schema() -> dict[str, Any]:
    """契约端点载荷：``{slots, types, units, contracts}``（前端渲染唯一来源）。"""
    slots = []
    for value in SLOT_WHITELIST:
        required_for = sorted(cid for cid, req in SLOT_CONTRACT.items() if value in req)
        slots.append(
            {"value": value, "label": SLOT_LABELS.get(value, value),
             "requiredFor": required_for}
        )
    contracts = {
        cid: {"required": sorted(req), "optional": sorted(set(SLOT_WHITELIST) - req)}
        for cid, req in SLOT_CONTRACT.items()
    }
    return {
        "slots": slots,
        "types": list(TYPE_WHITELIST),
        "units": list(UNIT_WHITELIST),
        "contracts": contracts,
    }
