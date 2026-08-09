#!/usr/bin/env python3
"""Deterministic OpenAPI 3.1 -> TypeScript types generator.

Mirrors the `components['schemas']` (and a convenience `operations` map) portion
of openapi-typescript's output, so docs/openapi.json can be converted to
web/src/types/api.ts without the CLI (which is unavailable in this sandbox).

Output shape is compatible with openapi-typescript's exported `components`
namespace, so this file is a drop-in if the real tool is run later.
"""
import json
import sys

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


def main():
    src = sys.argv[1]
    out = sys.argv[2]
    with open(src, encoding="utf-8") as f:
        spec = json.load(f)
    schemas = spec.get("components", {}).get("schemas", {})
    paths = spec.get("paths", {})

    lines = []
    lines.append("/* eslint-disable */")
    lines.append("// Generated from docs/openapi.json (OpenAPI 3.1).")
    lines.append("// Produced by a deterministic converter mirroring openapi-typescript's")
    lines.append("// `components['schemas']` output. Drop-in compatible if the CLI is run later.")
    lines.append("export interface paths { [name: string]: unknown }")
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

    # Convenience operationId -> 200-response schema name map.
    lines.append("")
    lines.append("/** operationId -> response schema name (HTTP 200, application/json). */")
    lines.append("export interface operations {")
    op_entries = []
    for path, methods in paths.items():
        if not isinstance(methods, dict):
            continue
        for method, op in methods.items():
            if not isinstance(op, dict):
                continue
            op_id = op.get("operationId")
            if not op_id:
                continue
            resp = (op.get("responses") or {}).get("200") or {}
            content = resp.get("content") or {}
            js = content.get("application/json") or {}
            sch = js.get("schema") or {}
            ref = sch.get("$ref")
            if ref:
                nm = ref.split("/")[-1]
                op_entries.append(f"{INDENT}{INDENT}{op_id}: components['schemas']['{nm}'];")
    if op_entries:
        lines.extend(op_entries)
    else:
        lines.append(f"{INDENT}{INDENT}[op: string]: unknown;")
    lines.append(f"{INDENT}}};")

    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"Wrote {out}: {len(schemas)} schemas, {len(op_entries)} operations")


if __name__ == "__main__":
    main()
