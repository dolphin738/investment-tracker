"""静态校验：required 过滤、字段结构校验、分类契约校验。"""

from __future__ import annotations

from typing import Any, Optional

from app.services.response_path import PathSyntaxError, parse_source

from ._constants import (
    COMPILED,
    KEY_PATTERN,
    MAX_SOURCE_SEGMENTS,
    SCALE_MAX,
    SCALE_MIN,
    SLOT_CONTRACT,
    SLOT_WHITELIST,
    TYPE_WHITELIST,
    UNIT_WHITELIST,
)

__all__ = ["filter_required_rows", "validate_response_fields", "check_slot_contract"]


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
