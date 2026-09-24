"""字段索引与命中率（试调面板 / 折叠派生共用）。"""

from __future__ import annotations

from typing import Any, Optional

from app.services.response_path import CompiledField

from ._constants import COMPILED

__all__ = ["index_by_slot", "index_by_key", "compute_slot_hit_rates"]


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
