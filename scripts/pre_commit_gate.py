#!/usr/bin/env python3
"""提交前置闸门（实施计划 §4.4「提交自动检测规则」的可自动化部分）。

每次 AI 生成代码提交前执行；任一自动检查不过即打回。人工检查项（依赖准入说明、
防御性垃圾、单一职责拆分）以清单形式打印，由提交人自证。

包含的自动检查：
  1. 后端 ruff（F：未使用 import/变量、未定义名）——读 backend/pyproject.toml 配置
  2. 后端 import-linter（架构边界：models 不反向依赖上层、services 不依赖路由层）
  3. 前端 knip 依赖/文件闸门（未被使用的依赖、未列名依赖、未使用文件、未使用导出）
  4. 行数预算（调 scripts/check_line_budget.py）
  5. 「缺测试」标记（调 scripts/check_tests_touched.py）：改了业务源码却没动测试时打标，
     默认告警（一次性重构属合理场景），设 REQUIRE_TESTS=1 升级为硬失败
  6. 后端覆盖率（调 scripts/check_coverage.py）：默认**跳过**（需跑全量 pytest，约 4 分钟），
     用 --only coverage 显式执行
  7. 前端覆盖率（调 scripts/check_frontend_coverage.py）：默认**跳过**；且主工作树因 pnpm
     环境漂移装不到 @vitest/coverage-v8，本地执行会直接报「依赖缺失」（退出码 3），
     该闸门实际由 CI（全新环境）强制执行
  8. 前端体积（调 scripts/check_bundle_size.py）：默认**跳过**（需 vite build，约 1 分钟），
     用 --only bundle 显式执行

用法：
  python scripts/pre_commit_gate.py               # 默认项（ruff/imports/knip/lines/tests）
  python scripts/pre_commit_gate.py --skip knip   # 离线快速模式
  python scripts/pre_commit_gate.py --only ruff   # 只跑某几项
  python scripts/pre_commit_gate.py --only coverage bundle  # 跑耗时项（CI 已含，本地按需）

退出码：存在任一失败项 → 1；否则 0。
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
KPIN_VERSION = "5"  # 与 CI 保持一致的大版本；配置见 web/knip.json

# 全部检查项；coverage 需跑全量 pytest（约 4 分钟）、bundle 需 vite build（约 1 分钟），
# 二者由 CI 强制（.cnb.yml），本地默认跳过，按需用 --only 显式执行。
ALL_CHECKS = frozenset(
    {"ruff", "imports", "knip", "lines", "tests", "coverage", "fe-coverage", "bundle"}
)
SLOW_CHECKS = frozenset({"coverage", "fe-coverage", "bundle"})

MANUAL_CHECKLIST = """
── 人工检查清单（提交人自证，§4.4-1/2/3/4）──
  □ 新增的每个 export 至少有一处使用（已由 knip exports 自动强制，本条仅作提交前提醒）
  □ 新增依赖已在提交说明中写明「为什么现有依赖/原生能力做不到」（§4.1-3 准入）
  □ 无防御性垃圾：异常后静默返回默认值、无意义重试包裹、复制粘贴相似块（相似度 ≥0.9）
  □ 本次提交只做一件事；功能+重构+格式化混排的先拆分再提交
──────────────────────────────────────────────"""


def _resolve(cmd: str) -> str:
    """Windows 下 subprocess 不能直接执行 .cmd（如 npx.cmd）→ 用 which 解析全路径。"""
    if os.name == "nt" and not cmd.lower().endswith((".exe", ".cmd", ".bat")):
        found = shutil.which(cmd)
        if found:
            return found
    return cmd


def _run(name: str, cmd: list[str], cwd: Path) -> bool:
    resolved = [_resolve(cmd[0]), *cmd[1:]]
    print(f"\n=== [{name}] {' '.join(cmd)} (cwd={cwd.name}) ===")
    result = subprocess.run(resolved, cwd=cwd, encoding="utf-8", errors="replace")
    ok = result.returncode == 0
    print(f"=== [{name}] {'✓ PASS' if ok else '✗ FAIL'} ===")
    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description="提交前置闸门")
    parser.add_argument(
        "--skip",
        nargs="*",
        default=[],
        choices=sorted(ALL_CHECKS),
        help="跳过指定检查（离线时跳 knip）",
    )
    parser.add_argument(
        "--only",
        nargs="*",
        default=None,
        choices=sorted(ALL_CHECKS),
        help="只运行指定检查（coverage/bundle 为耗时项，默认不跑）",
    )
    args = parser.parse_args()
    skip = set(args.skip)
    if args.only:
        skip = set(ALL_CHECKS) - set(args.only)
    else:
        skip |= SLOW_CHECKS  # 耗时项（全量 pytest / vite build）默认不进本地快检

    results: dict[str, bool] = {}

    if "ruff" not in skip:
        results["ruff"] = _run(
            "ruff", ["uvx", "ruff", "check", "app", "tests", "conftest.py"], REPO_ROOT / "backend"
        )
    if "imports" not in skip:
        results["imports"] = _run(
            "import-linter", ["uv", "run", "lint-imports"], REPO_ROOT / "backend"
        )
    if "knip" not in skip:
        results["knip"] = _run(
            "knip",
            ["npx", "-y", f"knip@{KPIN_VERSION}", "--include", "dependencies,unlisted,files,exports"],
            REPO_ROOT / "web",
        )
    if "lines" not in skip:
        results["lines"] = _run(
            "line-budget", [sys.executable, str(REPO_ROOT / "scripts" / "check_line_budget.py")], REPO_ROOT
        )
    if "tests" not in skip:
        results["tests"] = _run(
            "missing-test-tag",
            [sys.executable, str(REPO_ROOT / "scripts" / "check_tests_touched.py")],
            REPO_ROOT,
        )
    if "coverage" not in skip:
        results["coverage"] = _run(
            "coverage", [sys.executable, str(REPO_ROOT / "scripts" / "check_coverage.py")], REPO_ROOT
        )
    if "fe-coverage" not in skip:
        results["fe-coverage"] = _run(
            "frontend-coverage",
            [sys.executable, str(REPO_ROOT / "scripts" / "check_frontend_coverage.py")],
            REPO_ROOT,
        )
    if "bundle" not in skip:
        results["bundle"] = _run(
            "bundle-size",
            [sys.executable, str(REPO_ROOT / "scripts" / "check_bundle_size.py")],
            REPO_ROOT,
        )

    print(MANUAL_CHECKLIST)

    failed = [name for name, ok in results.items() if not ok]
    if failed:
        print(f"\n[提交闸门] ✗ 未通过：{', '.join(failed)} —— 打回，修复后重试。")
        return 1
    print("\n[提交闸门] ✓ 自动检查全部通过（人工清单项仍需自证）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
