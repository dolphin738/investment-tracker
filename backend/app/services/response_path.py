"""响应字段路径 DSL（纯逻辑，无 IO）——``source`` 解析与预编译访问器。

承载方案 §4.2 的路径语法（向后兼容现状 F5）与「编译一次、循环复用」的访问器闭包，
并把编译结果封装为 ``CompiledField`` 供 6 个消费点行循环调用。

语法：

- ``code``          → dict 顶层 key
- ``0`` / ``1``     → 单段：dict 行取**字面 key**；数组行取**位置下标**（历史语义，边界 2）
- ``a.b``           → 逐层 dict 取值
- ``items[0].code`` → 数组下标用方括号（消除与字面 key ``"0"`` 的歧义）
- ``a\\.b``         → 转义后的字面含点 key（akshare 列名常见，如 ``2024.06``）

歧义必须由显式转义消除，不做「先试路径再试字面 key」的静默双策略（方案边界 1）。

本模块不 import 任何业务 service / 模型 / FastAPI，仅依赖标准库。
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Callable, Optional

# 值类型 / 单位默认值（白名单在 response_fields 中声明，此处仅取缺省）
DEFAULT_TYPE = "string"
DEFAULT_UNIT = "none"


@dataclass(frozen=True)
class PathSegment:
    """路径段：``kind="key"`` → dict 字面 key；``kind="index"`` → 数组下标。"""

    kind: str
    value: Any


class PathSyntaxError(ValueError):
    """source 路径语法非法（如未闭合 ``[`` 或非数字下标）。"""


def parse_source(source: str) -> tuple[PathSegment, ...]:
    """把 source 路径字符串解析为段数组（供预编译）。非法语法抛 ``PathSyntaxError``。"""
    if not isinstance(source, str) or not source:
        raise PathSyntaxError("source 路径不能为空")
    segments: list[PathSegment] = []
    buf: list[str] = []

    def _flush_key() -> None:
        if buf:
            segments.append(PathSegment("key", "".join(buf)))
            buf.clear()

    i = 0
    n = len(source)
    while i < n:
        ch = source[i]
        if ch == "\\":
            # 转义：下一个字符作为字面字符（含点 / 反斜杠）
            i += 1
            if i < n:
                buf.append(source[i])
                i += 1
            else:
                buf.append("\\")
            continue
        if ch == ".":
            _flush_key()
            i += 1
            continue
        if ch == "[":
            _flush_key()  # 下标前若已有缓冲，作为一个 key 段
            close = source.find("]", i)
            if close == -1:
                raise PathSyntaxError(f"source 路径缺少 ']'：{source!r}")
            inner = source[i + 1 : close].strip()
            if not inner.isdigit():
                raise PathSyntaxError(f"数组下标必须为非负整数：{source!r}")
            try:
                index = int(inner)
            except ValueError:
                # 少数 Unicode 数字（如 "²"）isdigit() 为 True 但 int() 解析失败；
                # 此处转成干净的 PathSyntaxError（保存接口 400 而非 500）。
                raise PathSyntaxError(f"方括号下标须为十进制数字：{source!r}") from None
            segments.append(PathSegment("index", index))
            i = close + 1
            continue
        buf.append(ch)
        i += 1
    _flush_key()
    if not segments:
        raise PathSyntaxError(f"source 路径解析为空：{source!r}")
    return tuple(segments)


def _make_getter(segments: tuple[PathSegment, ...]) -> Callable[[Any], Any]:
    """由段数组产出访问器闭包（预编译，行循环只调用它）。"""
    if len(segments) == 1 and segments[0].kind == "key":
        key = segments[0].value
        if key.isdigit():
            idx = int(key)

            def _get_digit(row: Any) -> Any:
                if isinstance(row, dict):
                    return row.get(key)
                if isinstance(row, (list, tuple)):
                    return row[idx] if 0 <= idx < len(row) else None
                return None

            return _get_digit

        def _get_key(row: Any) -> Any:
            return row.get(key) if isinstance(row, dict) else None

        return _get_key

    def _get_path(row: Any) -> Any:
        cur = row
        for seg in segments:
            if cur is None:
                return None
            if seg.kind == "index":
                if isinstance(cur, (list, tuple)):
                    pos = seg.value
                    if 0 <= pos < len(cur):
                        cur = cur[pos]
                    else:
                        return None
                elif isinstance(cur, dict):
                    cur = cur.get(str(seg.value))
                else:
                    return None
            elif isinstance(cur, dict):
                cur = cur.get(seg.value)
            else:
                return None
        return cur

    return _get_path


@lru_cache(maxsize=2048)
def compile_source(source: str) -> Callable[[Any], Any]:
    """source 字符串 → 访问器闭包（LRU 缓存，避免重复解析同一路径）。"""
    return _make_getter(parse_source(source))


def row_get(row: Any, field: Optional[str]) -> Any:
    """从行取值（唯一收口 ``_row_get`` 的实现核心）。

    dict 走路径 / 字面 key；list 的单段纯数字 field 走位置下标（历史语义）；其余返回 None。
    非字符串 ``field``（历史兼容）在 dict 行按原值取 key、在数组行按 ``int`` 下标取。

    边界 3（NaN / ``pd.NA`` → ``None``）**P1 暂缓至 P2，勿视为已实现**：改造前同样
    原样透传（``_parse_price_rows`` 会产出 ``Decimal('NaN')``），未把 NaN 当 0，规格
    欲防的危害不存在；P1 阶段改动会引入数据语义变更，故保持现状。
    """
    if row is None or field is None:
        return None
    if not isinstance(field, str):
        if isinstance(row, dict):
            return row.get(field)
        if isinstance(row, (list, tuple)):
            try:
                idx = int(field)
            except (TypeError, ValueError):
                return None
            return row[idx] if 0 <= idx < len(row) else None
        return None
    if field == "":
        # D4：空字符串 field 保持 HEAD 语义（dict 行走 ``.get("")`` 一般为 None；
        # 数组行空下标返回 None），**不得**当作非法路径抛 ``PathSyntaxError``。
        # 其余非法语法（未闭合 ``[`` / 非数字下标等）仍照旧抛错。
        return row.get("") if isinstance(row, dict) else None
    return compile_source(field)(row)


@dataclass(frozen=True)
class CompiledField:
    """字段映射 → 已编译取数器（``source`` 已解析为访问器闭包）。"""

    key: str
    label: Optional[str]
    slot: Optional[str]
    source: str
    getter: Callable[[Any], Any]
    type: str = DEFAULT_TYPE
    required: bool = False
    scale: Optional[int] = None
    unit: str = DEFAULT_UNIT
    date_format: Optional[str] = None

    def get(self, row: Any) -> Any:
        """行内取值（行循环唯一调用点，无字符串解析）。"""
        return self.getter(row)


def compile_spec(spec: dict[str, Any]) -> CompiledField:
    """``response_fields`` 单条 → ``CompiledField``（source 预编译）。"""
    slot = spec.get("slot") or None
    source = str(spec.get("source") or "")
    return CompiledField(
        key=str(spec.get("key") or ""),
        label=spec.get("label"),
        slot=slot if slot else None,
        source=source,
        getter=compile_source(source),
        type=str(spec.get("type") or DEFAULT_TYPE),
        required=bool(spec.get("required") or False),
        scale=spec.get("scale"),
        unit=str(spec.get("unit") or DEFAULT_UNIT),
        date_format=spec.get("date_format"),
    )


def legacy_field(
    slot: str,
    source: str,
    *,
    label: Optional[str] = None,
    type: str = DEFAULT_TYPE,
    fallbacks: tuple[str, ...] = (),
) -> CompiledField:
    """由旧列合成单个 ``CompiledField``（可带中文列名兜底候选，按顺序尝试）。"""
    candidates = [source] + [f for f in fallbacks if f and f != source]
    getters = [compile_source(c) for c in candidates]
    if len(getters) == 1:
        getter: Callable[[Any], Any] = getters[0]
    else:

        def getter(row: Any) -> Any:
            for fn in getters:
                value = fn(row)
                if value is not None:
                    return value
            return None

    return CompiledField(
        key=slot, label=label, slot=slot, source=source, getter=getter, type=type
    )
