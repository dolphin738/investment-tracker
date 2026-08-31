#!/usr/bin/env python3
"""Deterministic OpenAPI 3.1 -> TypeScript types generator.

Mirrors the `components['schemas']` portion of openapi-typescript's output, so
docs/openapi.json can be converted to web/src/types/api.ts without the CLI
(which is unavailable in this sandbox).

REP-051 后仅输出 components（paths / operations 死壳前端零引用，已删除）：
- components['schemas']：后端 Pydantic schema 类型字典（单一事实源）；
- BUSINESS_ERROR_CODE：从 backend/app/core/enums.py 解析（见 gen_business_error_code）。

Output shape is compatible with openapi-typescript's exported `components`
namespace, so this file is a drop-in if the real tool is run later.
"""
import json
import re
import sys
from pathlib import Path

INDENT = "  "


def ref_name(ref: str) -> str:
    # '#/components/schemas/PortfolioOut' -> "components['schemas']['PortfolioOut']"
    parts = ref.split("/")
    assert parts[0] == "#", ref
    assert parts[1] == "components", ref
    assert parts[2] == "schemas", ref
    name = parts[3]
    return f"components['schemas']['{name}']"


def ts_type(schema: dict, depth: int = 0) -> str:
    if schema is None:
        return "unknown"
    if "$ref" in schema:
        return ref_name(schema["$ref"])
    if "anyOf" in schema:
        parts = [ts_type(s, depth) for s in schema["anyOf"]]
        inner = " | ".join(p for p in parts if p)
        return inner
    if "oneOf" in schema:
        parts = [ts_type(s, depth) for s in schema["oneOf"]]
        return " | ".join(p for p in parts if p)
    if "allOf" in schema:
        parts = [ts_type(s, depth) for s in schema["allOf"]]
        return " & ".join(p for p in parts if p)
    if "enum" in schema:
        vals = []
        for v in schema["enum"]:
            if v is None:
                vals.append("null")
            elif isinstance(v, str):
                vals.append(repr(v))
            else:
                vals.append(str(v))
        return " | ".join(vals)
    t = schema.get("type")
    if t == "array":
        items = schema.get("items", {})
        return ts_type(items, depth) + "[]"
    if t == "object" or "properties" in schema or "additionalProperties" in schema:
        props = schema.get("properties")
        addl = schema.get("additionalProperties")
        if props is None and addl is not None:
            if addl is True:
                return "Record<string, unknown>"
            return f"Record<string, {ts_type(addl, depth)}>"
        if props is None:
            return "Record<string, unknown>"
        required = set(schema.get("required", []))
        backing = schema.get("x-backingType")  # ignored
        lines = []
        for pname, pschema in props.items():
            ptype = ts_type(pschema, depth + 1)
            opt = "" if pname in required else "?"
            desc = pschema.get("description") or pschema.get("title")
            if desc:
                lines.append(f"{INDENT*(depth+2)}/** {desc} */")
            lines.append(f"{INDENT*(depth+2)}{pname}{opt}: {ptype};")
        body = "\n".join(lines)
        return "{\n" + body + f"\n{INDENT*(depth+1)}}}"
    if t == "null":
        return "null"
    if t == "string":
        return "string"
    if t in ("integer", "number"):
        return "number"
    if t == "boolean":
        return "boolean"
    fmt = schema.get("format")
    if fmt in ("date", "date-time", "uuid"):
        return "string"
    return "unknown"


def gen_business_error_code() -> list[str]:
    """Emit a `BUSINESS_ERROR_CODE` const + `BusinessErrorCode` type by parsing
    the `BusinessErrorCode` IntEnum in backend/app/core/enums.py.

    enums.py is the single source of truth; this keeps the generated
    web/src/types/api.ts in sync without a hand-maintained duplicate copy.
    """
    enums_path = (
        Path(__file__).resolve().parent.parent.parent
        / "backend" / "app" / "core" / "enums.py"
    )
    text = enums_path.read_text(encoding="utf-8")
    # Capture the BusinessErrorCode(IntEnum) class body.
    match = re.search(
        r"class BusinessErrorCode\(IntEnum\):(.*?)(?=\nclass |\Z)", text, re.S
    )
    if not match:
        raise RuntimeError("BusinessErrorCode not found in enums.py")
    body = match.group(1)
    # Enum members are indented exactly 4 spaces. Module-level constants such as
    # ACCOUNT_RETENTION_DAYS sit at column 0 and must be excluded. A bare `^\s+`
    # is unsafe here: in MULTILINE mode it absorbs the blank-line newline that
    # precedes a column-0 constant, falsely treating that constant as indented.
    # Requiring the literal 4-space indent prevents that and keeps the output to
    # the 12 BusinessErrorCode members only.
    members = [
        (m.group(1), int(m.group(2)))
        for m in re.finditer(r"^    (\w+)\s*=\s*(\d+)", body, re.M)
    ]
    if not members:
        raise RuntimeError("No BusinessErrorCode members parsed from enums.py")

    gen_lines: list[str] = []
    gen_lines.append("")
    gen_lines.append(
        "// ── Generated from backend/app/core/enums.py BusinessErrorCode "
        "(single source of truth) ──"
    )
    gen_lines.append("export const BUSINESS_ERROR_CODE = {")
    for name, value in members:
        gen_lines.append(f"{INDENT}{name}: {value},")
    gen_lines.append("} as const;")
    gen_lines.append(
        "export type BusinessErrorCode = "
        "(typeof BUSINESS_ERROR_CODE)[keyof typeof BUSINESS_ERROR_CODE];"
    )
    return gen_lines


def main():
    src = sys.argv[1]
    out = sys.argv[2]
    with open(src, encoding="utf-8") as f:
        spec = json.load(f)
    schemas = spec.get("components", {}).get("schemas", {})

    lines = []
    lines.append("/* eslint-disable */")
    lines.append("// Generated from docs/openapi.json (OpenAPI 3.1) by web/scripts/gen-api-types.py.")
    lines.append("// components['schemas'] 为后端 Pydantic schema 类型字典；paths / operations 死壳")
    lines.append("// 已按 REP-051 删除，不再生成。BUSINESS_ERROR_CODE 见文件尾（enums.py 单一事实源）。")
    lines.append("export interface components {")
    lines.append(f"{INDENT}schemas: {{")

    for name in sorted(schemas.keys()):
        sch = schemas[name]
        desc = sch.get("description") or sch.get("title")
        if desc:
            lines.append(f"{INDENT}{INDENT}/** {desc} */")
        body = ts_type(sch, depth=2)
        lines.append(f"{INDENT}{INDENT}{name}: {body};")

    lines.append(f"{INDENT}}};")
    lines.append("}")

    # Business error codes — parsed from backend/app/core/enums.py (single source
    # of truth) so the generated file stays in sync with the Python backend.
    lines.extend(gen_business_error_code())

    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"Wrote {out}: {len(schemas)} schemas")


if __name__ == "__main__":
    main()
