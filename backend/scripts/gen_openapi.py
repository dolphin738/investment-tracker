"""从 FastAPI app 导出完整 OpenAPI schema（Phase 5 契约源）。

用法（在项目 backend/ 目录、venv 激活下）：
    python scripts/gen_openapi.py            # 默认输出 ../docs/openapi.json
    python scripts/gen_openapi.py -o out.json

注意：app.openapi() 仅构建路由 + Pydantic 模型 schema，不连接数据库，可离线运行。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# 允许以脚本形式直接运行：把 backend/ 加入 sys.path
BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_ROOT))

from app.main import app  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="导出 FastAPI OpenAPI schema")
    parser.add_argument(
        "-o",
        "--output",
        default=str(BACKEND_ROOT.parent / "docs" / "openapi.json"),
        help="输出 JSON 路径（默认 ../docs/openapi.json）",
    )
    args = parser.parse_args()

    schema = app.openapi()
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    # 稳定排序，便于 diff
    schema["paths"] = dict(sorted(schema.get("paths", {}).items()))
    out.write_text(
        json.dumps(schema, ensure_ascii=False, indent=2, sort_keys=False),
        encoding="utf-8",
    )

    paths = schema.get("paths", {})
    methods = 0
    for ops in paths.values():
        methods += sum(1 for k in ops if k in {"get", "post", "put", "patch", "delete"})
    print(f"[gen_openapi] 写入 {out}")
    print(f"[gen_openapi] paths={len(paths)} operations={methods}")
    # 列出全部路由，便于人工核对
    for p in sorted(paths):
        verbs = ",".join(sorted(k.upper() for k in paths[p] if k in {"get", "post", "put", "patch", "delete"}))
        print(f"  {verbs:20s} {p}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
