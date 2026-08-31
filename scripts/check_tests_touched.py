#!/usr/bin/env python3
"""阶段4 防反弹闸门：「缺测试」标记（架构治理规范 §6）。

用法：
  python scripts/check_tests_touched.py                # 与 origin/main 的 merge-base 比较
  python scripts/check_tests_touched.py --base main    # 指定基线分支/提交
  REQUIRE_TESTS=1 python scripts/check_tests_touched.py   # 缺测试时返回 1（硬闸门）

规则：
- 取 ``git diff --name-only <merge-base(base)..HEAD>`` 的改动文件清单
  （口径同 ``check_line_budget.py``：只比较已提交内容，不含工作区未提交改动）。
- 源码文件（改动这些就期望有测试变更）：
  ``backend/app/**/*.py``、``web/src/**/*.ts``、``web/src/**/*.vue``；
  排除本身就是测试的（路径含 ``__tests__/`` 或文件名以 ``.test.ts``/``.spec.ts`` 结尾），
  排除生成物 ``web/src/types/api.ts``（由 web/scripts/gen-api-types.py 生成，禁止手改）。
- 测试文件（存在任一变更即视为「带测试」）：``backend/tests/**``、
  ``web/src/**/__tests__/**``、``web/src/**/*.test.ts``、``web/src/**/*.spec.ts``、
  ``web/e2e/**``，以及测试辅助设施 ``backend/conftest.py``、``web/vitest.config.*``、
  ``web/src/test/**``。
- 文档（``.md``/``docs/**``）、锁文件、``*.yml``/``*.yaml``、``*.json``、``.importlinter``、
  ``.gitignore``、脚本目录（``scripts/**``、``dev-scripts/**``）与二进制资源均非业务源码，
  改动它们不要求测试。
- 基线分支不可解析时（如浅克隆未取到 origin/main）只警告并放行（退出码 0），
  不阻塞流水线——理由同行数闸门。
- 本闸门默认只**告警**（一次性重构、纯配置改动属合理无测试场景）；
  设置环境变量 REQUIRE_TESTS=1 时缺测试返回 1，供 CI 将来升级为硬闸门。

退出码：0 通过/跳过/告警；1 缺测试且 REQUIRE_TESTS=1；3 git 异常。
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import PurePosixPath

# 基线分支探测顺序（与 check_line_budget.py 保持一致）
DEFAULT_BASE_CANDIDATES = ("origin/main", "cnb/main", "main")

# 源码： (路径前缀, 后缀) 白名单。git 输出恒为 `/` 分隔，统一用 PurePosixPath 解析。
SOURCE_PATTERNS: tuple[tuple[str, str], ...] = (
    ("backend/app/", ".py"),
    ("web/src/", ".ts"),
    ("web/src/", ".vue"),
)

# 生成物：规则上禁止手改，改动它不算业务源码改动
SOURCE_EXCLUDED_PATHS = frozenset({"web/src/types/api.ts"})

# 测试文件：整路径命中
TEST_EXACT_PATHS = frozenset({"backend/conftest.py"})
# 测试文件：前缀命中（web/vitest.config.* 覆盖 .ts/.mts 等变体）
TEST_PREFIXES = (
    "backend/tests/",
    "web/e2e/",
    "web/src/test/",
    "web/vitest.config.",
)
# 测试文件：后缀命中
TEST_SUFFIXES = (".test.ts", ".spec.ts")
# 测试文件：路径片段命中（web/src/**/__tests__/**）
TEST_DIR_MARKER = "__tests__"

# 报告时最多列出的未覆盖源码文件数
MAX_LISTED_FILES = 10


def _run_git(args: list[str]) -> str:
    result = subprocess.run(
        # core.quotepath=false：中文路径不转义为八进制（否则 docs/ 前缀与 .md
        # 后缀判断失效——本项目实测坑）。
        ["git", "-c", "core.quotepath=false", *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} 失败: {result.stderr.strip()}")
    return result.stdout.strip()


def _is_test_path(path: str) -> bool:
    """是否为测试文件或测试辅助设施。"""
    if path in TEST_EXACT_PATHS or path.startswith(TEST_PREFIXES):
        return True
    # __tests__ 目录：按路径片段判断，兼容 web 与 backend 两侧的命名差异
    if TEST_DIR_MARKER in PurePosixPath(path).parts:
        return True
    return path.endswith(TEST_SUFFIXES)


def _is_source_path(path: str) -> bool:
    """是否为「改动后期望有测试变更」的业务源码文件。"""
    if path in SOURCE_EXCLUDED_PATHS:
        return False
    if _is_test_path(path):
        return False
    return any(
        path.startswith(prefix) and path.endswith(suffix)
        for prefix, suffix in SOURCE_PATTERNS
    )


def _classify(paths: list[str]) -> tuple[list[str], list[str]]:
    """拆分 (源码改动, 测试改动)，均按路径排序。"""
    source = sorted(p for p in paths if _is_source_path(p))
    tests = sorted(p for p in paths if _is_test_path(p))
    return source, tests


def _collect_changes(base_ref: str) -> list[str]:
    """返回 merge-base(base)..HEAD 的改动文件路径清单。"""
    merge_base = _run_git(["merge-base", base_ref, "HEAD"])
    diff = _run_git(["diff", "--name-only", f"{merge_base}..HEAD"])
    return [line.strip() for line in diff.splitlines() if line.strip()]


def _resolve_base(candidates: list[str]) -> str | None:
    for candidate in candidates:
        try:
            _run_git(["rev-parse", "--verify", candidate])
            return candidate
        except RuntimeError:
            continue
    return None


def main() -> int:
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except Exception:  # noqa: BLE001 - 纯展示性兜底
            pass

    parser = argparse.ArgumentParser(description="「缺测试」标记检查（告警型闸门）")
    parser.add_argument(
        "--base",
        default=None,
        help="基线分支/提交；缺省时按 origin/main → cnb/main → main 顺序探测",
    )
    args = parser.parse_args()

    base_candidates = [args.base] if args.base else list(DEFAULT_BASE_CANDIDATES)
    base_ref = _resolve_base(base_candidates)
    if base_ref is None:
        print(f"[缺测试检查] 基线不可解析（已尝试: {', '.join(base_candidates)}），跳过")
        return 0

    try:
        changed = _collect_changes(base_ref)
    except RuntimeError as exc:
        print(f"[缺测试检查] git 异常：{exc}")
        return 3

    source_files, test_files = _classify(changed)

    print(
        f"[缺测试检查] 基线 {base_ref} → HEAD：改动文件 {len(changed)} 个，"
        f"其中业务源码 {len(source_files)} 个、测试 {len(test_files)} 个"
    )

    if not source_files:
        print("[缺测试检查] 本次无业务源码改动，跳过")
        return 0

    if test_files:
        for path in test_files[:3]:
            print(f"  测试变更: {path}")
        if len(test_files) > 3:
            print(f"  …等 {len(test_files)} 个测试文件")
        print("[缺测试检查] 通过：业务源码改动已伴随测试变更")
        return 0

    print("【缺测试】本次改动涉及业务源码，但未检测到任何测试变更。")
    print("  未覆盖测试的源码文件：")
    for path in source_files[:MAX_LISTED_FILES]:
        print(f"    - {path}")
    if len(source_files) > MAX_LISTED_FILES:
        print(f"    …等 {len(source_files)} 个")
    print(
        "  提示：如属一次性重构、纯配置调整、生成物刷新等场景，可忽略本告警；\n"
        "        否则应补充对应测试，或在评审中说明不补测试的原因。\n"
        "  升级为硬闸门：设置环境变量 REQUIRE_TESTS=1。"
    )
    if os.environ.get("REQUIRE_TESTS") == "1":
        print("[缺测试检查] 检测到 REQUIRE_TESTS=1，缺测试视为失败。")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
