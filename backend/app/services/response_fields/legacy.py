"""旧列合成 / 读入口：code 槽候选、旧列合成、resolve_fields 唯一读入口。"""

from __future__ import annotations

from typing import Any

from app.services.response_path import DEFAULT_TYPE, CompiledField, compile_spec, legacy_field

from ._constants import (
    COMPILED,
    NOTICE_CAT_ID,
    SLOT_CODE,
    SLOT_DATE,
    SLOT_EXCHANGE,
    SLOT_LABELS,
    SLOT_NAME,
    SLOT_PRICE,
    _FALLBACK_CODE_FIELD,
    _NOTICE_CODE_FIELD,
    _CODE_FALLBACK_CATEGORIES,
    _SLOT_DEFAULT_TYPE,
)

__all__ = ["_code_candidates", "_code_field", "_synthesize_legacy", "resolve_fields", "code_candidates_for"]


def _code_candidates(
    category_id: Any, resp_code_field: Any, *, include_legacy_code_fallback: bool
) -> list[str]:
    """``code`` 槽候选顺序 —— **按 category_id 的确定性分派**（非兜底逻辑）。

    改造前两条消费点的**真实顺序本就不同**，故不能用一个固定顺序；此处逐条对齐 HEAD
    （``git show HEAD:`` 实证，见 D1/D3）：

    - ``"4"``（公告，F9.6 ``dividend_notice_scan``）：中文列名「代码」**优先**，
      取不到（``None``）才试 ``resp_code_field``；
    - ``"3"``（分红列表，F9.5 ``dividend_sync._code_of``）：``resp_code_field``
      **优先**（**空值跳过**），再试中文列名「代码」；
    - 其余（主数据 / 行情 / 试调）：仅 ``resp_code_field or "code"``，**无**中文兜底
      （HEAD ``_prepare_master_rows`` / ``_parse_price_rows`` 语义）。

    ``include_legacy_code_fallback=False`` 强制返回单候选 ``resp_code_field or "code"``，
    供主数据 / 行情 / 试调链路**显式关闭** F4 中文兜底，避免兜底外溢（D2）。
    """
    raw = resp_code_field if isinstance(resp_code_field, str) else None
    default_source = raw or "code"
    cat = str(category_id) if category_id is not None else None
    if not include_legacy_code_fallback or cat not in _CODE_FALLBACK_CATEGORIES:
        return [default_source]
    if cat == NOTICE_CAT_ID:
        # 公告：中文列名优先（HEAD dividend_notice_scan 的 _COL_NOTICE_CODE 分支）
        candidates = [_NOTICE_CODE_FIELD]
        if raw:
            candidates.append(raw)
        return candidates
    # 分红：配置列优先且空值跳过（HEAD dividend_sync._code_of）
    candidates = []
    if raw:
        candidates.append(raw)
    candidates.append(_FALLBACK_CODE_FIELD)
    return candidates


def _code_field(itf: Any, *, include_legacy_code_fallback: bool) -> CompiledField:
    """由旧列合成 ``code`` 槽（候选顺序见 :func:`_code_candidates`）。"""
    candidates = _code_candidates(
        getattr(itf, "category_id", None),
        getattr(itf, "resp_code_field", None),
        include_legacy_code_fallback=include_legacy_code_fallback,
    )
    return legacy_field(
        SLOT_CODE, candidates[0],
        label=SLOT_LABELS[SLOT_CODE],
        fallbacks=tuple(candidates[1:]),
    )


def _synthesize_legacy(itf: Any, *, include_legacy_code_fallback: bool = True) -> COMPILED:
    """旧 4 列 + ``response_parse.resp_date_field`` → 字段列表（确定性历史兼容分支）。

    仅当 ``response_fields`` 为空（历史行）时启用；逐行解析结果与改造前一致。

    ``include_legacy_code_fallback``：是否启用 F4 中文列名兜底。默认 ``True``（按
    category_id 分派，见 :func:`_code_candidates`）；主数据 / 行情 / 试调链路显式传
    ``False``，使 ``code`` 槽退回 HEAD 的 ``resp_code_field or "code"`` 单候选语义。
    """
    rp = getattr(itf, "response_parse", None) or {}
    fields: COMPILED = [
        _code_field(itf, include_legacy_code_fallback=include_legacy_code_fallback)
    ]
    for slot, attr, default in (
        (SLOT_NAME, "resp_name_field", "name"),
        (SLOT_PRICE, "resp_price_field", "price"),
    ):
        fields.append(
            legacy_field(
                slot,
                getattr(itf, attr, None) or default,
                label=SLOT_LABELS[slot],
                type=_SLOT_DEFAULT_TYPE.get(slot, DEFAULT_TYPE),
            )
        )
    exchange = getattr(itf, "resp_exchange_field", None)
    if exchange:
        fields.append(
            legacy_field(SLOT_EXCHANGE, str(exchange), label=SLOT_LABELS[SLOT_EXCHANGE])
        )
    date_field = rp.get("resp_date_field")
    if date_field:
        fields.append(
            legacy_field(
                SLOT_DATE, str(date_field),
                label=SLOT_LABELS[SLOT_DATE], type=_SLOT_DEFAULT_TYPE[SLOT_DATE],
            )
        )
    return fields


def resolve_fields(itf: Any, *, include_legacy_code_fallback: bool = True) -> COMPILED:
    """字段映射 → 已编译取数器（**6 个消费点的唯一读入口**）。

    ``response_fields`` 非空列表 → 以其为准；为空 → 旧列合成（仅覆盖历史行）。
    支持仅有旧列属性的接口桩对象（``getattr`` 容错），不访问数据库。

    ``include_legacy_code_fallback``（仅对旧列合成分支生效）：
    - ``True``（默认）：按 category_id 分派 F4 中文列名兜底候选（见
      :func:`_code_candidates`）——分红记录取码 / 公告取码两条消费点与 HEAD 逐行等价；
    - ``False``：``code`` 槽仅 ``resp_code_field or "code"``，**禁用**中文兜底——
      主数据 / 行情 / 试调链路按 HEAD 语义，防止兜底外溢（D2）。
    """
    raw = getattr(itf, "response_fields", None)
    if isinstance(raw, list) and raw:
        return [compile_spec(spec) for spec in raw if isinstance(spec, dict)]
    return _synthesize_legacy(
        itf, include_legacy_code_fallback=include_legacy_code_fallback
    )


def code_candidates_for(itf: Any) -> list[str]:
    """``code`` 槽候选（按 category 分派，含 F4 中文兜底），供**按行访问语义与 HEAD 不同**
    的消费点自行取值。

    正常路径统一走 :func:`resolve_fields` 的编译访问器；唯 ``dividend_sync._code_of``
    （F9.5）在 HEAD 用 **dict-only** ``row.get(field)``（不解析点号路径、不取数组下标），
    故该消费点需拿到候选名后自行 ``row.get``，方能与 HEAD 逐行等价。
    """
    return _code_candidates(
        getattr(itf, "category_id", None),
        getattr(itf, "resp_code_field", None),
        include_legacy_code_fallback=True,
    )
