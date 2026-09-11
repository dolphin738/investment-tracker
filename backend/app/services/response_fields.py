"""响应字段配置核心（纯逻辑，无 IO / 无 DB / 无框架依赖）。

承载方案 §4/§5：slot 闭集白名单、按同步用途的分类契约、**唯一读入口**
``resolve_fields()``（response_fields 非空 → 以其为准；为空 → 由旧 4 列 +
``response_parse.resp_date_field`` 确定性合成，并对分红/公告用途追加中文列名兜底 F4），
以及 Expand 双写所需的旧列折叠 / 派生与契约端点载荷。路径解析与 ``CompiledField``
见 ``response_path``；本模块只做字段语义与校验编排。
"""
from __future__ import annotations

import re
from typing import Any, Optional

from app.services.response_path import (
    DEFAULT_TYPE,
    DEFAULT_UNIT,
    CompiledField,
    PathSyntaxError,
    compile_spec,
    legacy_field,
    parse_source,
)

__all__ = [
    "SLOT_CODE", "SLOT_NAME", "SLOT_EXCHANGE", "SLOT_PRICE", "SLOT_DATE",
    "SLOT_WHITELIST", "SLOT_LABELS", "TYPE_WHITELIST", "UNIT_WHITELIST",
    "DEFAULT_TYPE", "DEFAULT_UNIT", "KEY_PATTERN", "SCALE_MIN", "SCALE_MAX",
    "MAX_SOURCE_SEGMENTS", "SLOT_CONTRACT", "COMPILED",
    "resolve_fields", "index_by_slot", "index_by_key", "compute_slot_hit_rates",
    "filter_required_rows", "code_candidates_for",
    "validate_response_fields", "check_slot_contract",
    "fold_legacy_columns", "derive_legacy_columns", "build_field_schema",
]

# slot 闭集白名单（仅 5 个，方案 §4.1）——每个 slot 背后必须有代码消费者
# --------------------------------------------------------------------------- #
SLOT_CODE = "code"          # 证券代码（4 个同步用途均必填）
SLOT_NAME = "name"          # 证券名称（MASTER_LIST）
SLOT_EXCHANGE = "exchange"  # 交易所（MASTER_LIST，缺失按代码前缀推断）
SLOT_PRICE = "price"        # 价格 / 收盘价（QUOTE）
SLOT_DATE = "date"          # 日期（QUOTE 日线，返回时效校验）

SLOT_WHITELIST: tuple[str, ...] = (
    SLOT_CODE, SLOT_NAME, SLOT_EXCHANGE, SLOT_PRICE, SLOT_DATE,
)

SLOT_LABELS: dict[str, str] = {
    SLOT_CODE: "证券代码",
    SLOT_NAME: "证券名称",
    SLOT_EXCHANGE: "交易所",
    SLOT_PRICE: "价格 / 收盘价",
    SLOT_DATE: "日期",
}

# 值类型 / 单位白名单与数值约束（方案 §4 字段结构）
TYPE_WHITELIST: tuple[str, ...] = ("string", "number", "decimal", "date", "bool")
UNIT_WHITELIST: tuple[str, ...] = ("none", "yuan", "wan", "pct")
KEY_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
SCALE_MIN = 0
SCALE_MAX = 8
MAX_SOURCE_SEGMENTS = 5  # source 路径段数上限（信封已解包，深度 1~2 层足够）

# 同步用途分类 id（与 market_data_sync 的 4 个 purpose 常量一致；此处用字面量，
# 避免纯逻辑模块反向依赖 service 层）。
MASTER_LIST_CAT_ID = "1"    # 主数据（证券列表）
QUOTE_CAT_ID = "2"          # 价格 / 日线
DIVIDEND_LIST_CAT_ID = "3"  # 分红列表
NOTICE_CAT_ID = "4"         # 公告扫描

# 分类契约：按 4 个同步用途枚举必填 slot（方案 §4.1 / §6 单一真相）。
# 仅强制**无兜底**的槽（code / price / date）；name / exchange 有兜底故不进必填。
SLOT_CONTRACT: dict[str, frozenset[str]] = {
    MASTER_LIST_CAT_ID: frozenset({SLOT_CODE}),
    QUOTE_CAT_ID: frozenset({SLOT_CODE, SLOT_PRICE, SLOT_DATE}),
    DIVIDEND_LIST_CAT_ID: frozenset({SLOT_CODE}),
    NOTICE_CAT_ID: frozenset({SLOT_CODE}),
}

# COMPILED：resolve_fields 结果类型别名（语义标签）
COMPILED = list[CompiledField]

# --------------------------------------------------------------------------- #
# 历史遗留「隐式真相」常量（F4）：集中于此，供旧列合成时追加尝试。
# 消费点不得再各自硬编码这些列名（P1 护栏 ⑥，见 test_response_fields_guardrail.py）。
_FALLBACK_CODE_FIELD = "代码"   # 东财 stock_fhps_em 代码列（原 dividend_sync._FALLBACK_CODE_FIELD）
_NOTICE_CODE_FIELD = "代码"     # 公告 stock_notice_report 代码列（原 dividend_notice_scan._COL_NOTICE_CODE）

# 中文代码列兜底**仅**适用于分红 / 公告用途接口（F4 的两处隐式真相所在）；
# 主数据 / 行情接口历史上**没有**该兜底，不得引入（否则会掩盖列名错配，见
# test_upsert_masters_warns_on_zero_output_with_rows）。
_CODE_FALLBACK_CATEGORIES = frozenset({DIVIDEND_LIST_CAT_ID, NOTICE_CAT_ID})

# 旧列 → slot 语义映射（合成 / 双写共用）
_LEGACY_SLOT_COLUMNS: dict[str, str] = {
    SLOT_CODE: "resp_code_field",
    SLOT_PRICE: "resp_price_field",
    SLOT_NAME: "resp_name_field",
    SLOT_EXCHANGE: "resp_exchange_field",
}
_SLOT_DEFAULT_TYPE: dict[str, str] = {SLOT_PRICE: "decimal", SLOT_DATE: "date"}


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
      （HEAD ``_prepare_master_rows`` / ``_parse_price_rows`` / ``_parse_test_rows`` 语义）。

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


def index_by_slot(fields: COMPILED) -> dict[str, CompiledField]:
    """按 slot 快速取用（同接口 slot 唯一；无 slot 的展示字段不入索引）。"""
    out: dict[str, CompiledField] = {}
    for field in fields:
        if field.slot and field.slot not in out:
            out[field.slot] = field
    return out


def index_by_key(fields: COMPILED) -> dict[str, CompiledField]:
    """按 key 取用（展示字段亦可，供试调面板按 key 展示）。"""
    return {field.key: field for field in fields if field.key}


def compute_slot_hit_rates(
    fields: COMPILED, rows: list[Any]
) -> list[dict[str, Any]]:
    """逐槽位命中率（试调面板用）：每个 slot 的命中 / 缺失行数与样本值。

    仅统计有 slot 的字段（展示字段不出现在命中率里，方案 §5.2）。
    """
    out: list[dict[str, Any]] = []
    for field in fields:
        if not field.slot:
            continue
        hit = 0
        missing = 0
        sample: Optional[str] = None
        for row in rows:
            value = field.get(row)
            if value is None:
                missing += 1
            else:
                hit += 1
                if sample is None:
                    sample = str(value)
        out.append(
            {
                "slot": field.slot, "key": field.key, "label": field.label,
                "hit": hit, "missing": missing, "sample": sample,
            }
        )
    return out


def filter_required_rows(fields: COMPILED, rows: list[Any]) -> tuple[list[Any], int]:
    """按 ``required=true`` 字段过滤行（方案 §8 边界 6）：**整行丢弃 + 计数**。

    语义：任一声明 ``required=true`` 的字段在某行取值为 ``None``（缺失）→ 丢弃该整行，
    而非补默认值；返回 ``(保留行, 丢弃行数)``。

    零行为影响保证：无 ``required`` 字段时原样返回输入（现存 13 个接口的配置均为
    NULL / 旧列，``required`` 恒为 ``False``，故 P1 阶段不触发）。
    """
    required = [field for field in fields if field.required]
    if not required:
        return list(rows), 0
    kept: list[Any] = []
    dropped = 0
    for row in rows:
        if any(field.get(row) is None for field in required):
            dropped += 1
        else:
            kept.append(row)
    return kept, dropped


# 静态校验（方案 §6，返回错误消息列表；由 service 层翻译为 400）
def validate_response_fields(fields: Any) -> list[str]:
    """静态校验 ``response_fields``；返回错误消息列表（空 = 通过）。

    规则：``key`` 必填且匹配 ``^[a-z][a-z0-9_]{0,63}$`` 且接口内唯一；``slot`` 属闭集
    白名单且不可重复；``source`` 非空且路径段数 ≤5；``scale`` 仅 ``decimal`` 且 0~8；
    ``type`` / ``unit`` 白名单。
    """
    errors: list[str] = []
    if fields is None:
        return errors
    if not isinstance(fields, list):
        return ["response_fields 必须是数组"]

    seen_keys: set[str] = set()
    seen_slots: set[str] = set()
    for idx, spec in enumerate(fields):
        where = f"第 {idx + 1} 项"
        if not isinstance(spec, dict):
            errors.append(f"{where}不是对象")
            continue

        key = spec.get("key")
        if not isinstance(key, str) or not key:
            errors.append(f"{where}缺少 key")
        elif not KEY_PATTERN.match(key):
            errors.append(f"{where}key 非法（须匹配 ^[a-z][a-z0-9_]{{0,63}}$）：{key!r}")
        elif key in seen_keys:
            errors.append(f"{where}key 重复：{key!r}")
        else:
            seen_keys.add(key)

        slot = spec.get("slot")
        if slot not in (None, ""):
            if slot not in SLOT_WHITELIST:
                errors.append(
                    f"{where}slot 非法（白名单：{'/'.join(SLOT_WHITELIST)}）：{slot!r}"
                )
            elif slot in seen_slots:
                errors.append(f"{where}slot 重复：{slot!r}")
            else:
                seen_slots.add(slot)

        source = spec.get("source")
        if not isinstance(source, str) or not source.strip():
            errors.append(f"{where}缺少 source")
        else:
            try:
                segments = parse_source(source)
            except PathSyntaxError as exc:
                errors.append(f"{where}source 路径非法：{exc}")
            else:
                if len(segments) > MAX_SOURCE_SEGMENTS:
                    errors.append(
                        f"{where}source 路径段数 {len(segments)} 超过上限"
                        f" {MAX_SOURCE_SEGMENTS}"
                    )

        ftype = spec.get("type")
        if ftype not in (None, "") and ftype not in TYPE_WHITELIST:
            errors.append(
                f"{where}type 非法（白名单：{'/'.join(TYPE_WHITELIST)}）：{ftype!r}"
            )
        scale = spec.get("scale")
        if scale is not None:
            if ftype not in (None, "", "decimal"):
                errors.append(f"{where}scale 仅 decimal 类型可用")
            if (
                isinstance(scale, bool)
                or not isinstance(scale, int)
                or not (SCALE_MIN <= scale <= SCALE_MAX)
            ):
                errors.append(
                    f"{where}scale 非法（须为 {SCALE_MIN}~{SCALE_MAX} 整数）：{scale!r}"
                )
        unit = spec.get("unit")
        if unit not in (None, "") and unit not in UNIT_WHITELIST:
            errors.append(
                f"{where}unit 非法（白名单：{'/'.join(UNIT_WHITELIST)}）：{unit!r}"
            )
        date_format = spec.get("date_format")
        if date_format is not None and not isinstance(date_format, str):
            errors.append(f"{where}date_format 必须为字符串")
    return errors


def check_slot_contract(
    fields: list[dict[str, Any]], category_id: Optional[str]
) -> list[str]:
    """分类契约：按同步用途 purpose 校验必填 slot；返回错误消息列表。

    仅当 ``category_id`` 命中 4 个同步用途时强制；用户 CRUD 展示分类无契约（方案 §4.1）。
    """
    if category_id is None:
        return []
    required = SLOT_CONTRACT.get(str(category_id))
    if not required:
        return []
    present = {
        spec.get("slot") for spec in fields
        if isinstance(spec, dict) and spec.get("slot")
    }
    missing = sorted(required - present)
    if missing:
        return [f"该分类（用途 {category_id}）必须配置 slot：{'、'.join(missing)}"]
    return []


# 旧列折叠 / 派生（Expand 双写）
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


# 契约单源供给（GET /quote-interfaces/response-field-schema）
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
