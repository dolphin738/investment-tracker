#!/usr/bin/env python3
"""阶段4 行数闸门：单 PR/分支 diff 新增行数超限时打回（实施计划 §4.3-4）。

用法：
  python scripts/check_line_budget.py                # 与 origin/main 的 merge-base 比较
  python scripts/check_line_budget.py --base main    # 指定基线分支
  python scripts/check_line_budget.py --limit 800    # 上限（默认 800）

规则：
- 统计 ``git diff --numstat <merge-base(base)..HEAD>`` 的**新增行数**（不含删除）。
- 排除锁文件与生成物（pnpm-lock.yaml / uv.lock / package-lock.json / *.snap），
  避免机械性变更吞掉预算。
- 超限退出码 2，输出拆分指引；人工审定后可设环境变量 LARGE_PR_APPROVED=1 显式豁免
  （owner 在 CI 变量层面控制，豁免动作本身即「人工说明」的落点）。
- 基线分支不可解析时（如浅克隆未取到 origin/main）只警告并放行（退出码 0），
  不阻塞流水线——预算闸门在 PR 事件下最有意义。

退出码：0 通过；2 超预算；3 git 异常。
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys

# 机械性/生成物文件：不计入新增行数（按路径后缀或全名匹配）
EXCLUDED_NAMES = {
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "uv.lock",
    "poetry.lock",
    "Cargo.lock",
}
EXCLUDED_SUFFIXES = (".snap", ".svg", ".ico", ".png", ".jpg", ".woff", ".woff2")

DEFAULT_BASE_CANDIDATES = ("origin/main", "cnb/main", "main")
DEFAULT_LIMIT = 800


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


def _collect_added_lines(base_ref: str) -> tuple[int, list[tuple[int, str]]]:
    """返回 (新增总行数, [(新增行数, 路径)])，已排除锁文件/生成物。"""
    merge_base = _run_git(["merge-base", base_ref, "HEAD"])
    numstat = _run_git(["diff", "--numstat", f"{merge_base}..HEAD"])
    total = 0
    per_file: list[tuple[int, str]] = []
    for line in numstat.splitlines():
        if not line.strip():
            continue
        added, _deleted, path = line.split("\t", 2)
        if added == "-":  # 二进制文件
            continue
        name = os.path.basename(path)
        if name in EXCLUDED_NAMES or path.endswith(EXCLUDED_SUFFIXES):
            continue
        if path.endswith(".md") or path.startswith("docs/"):
            continue  # 计划口径为「新增代码」：文档不计入
        total += int(added)
        per_file.append((int(added), path))
    return total, sorted(per_file, reverse=True)


def main() -> int:
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except Exception:  # noqa: BLE001 - 纯展示性兜底
            pass

    parser = argparse.ArgumentParser(description="行数闸门（默认 800 行）")
    parser.add_argument(
        "--base",
        default=None,
        help="基线分支；缺省时按 origin/main → cnb/main → main 顺序探测",
    )
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="新增行数上限")
    args = parser.parse_args()

    if args.base:
        base_candidates = [args.base]
    else:
        base_candidates = list(DEFAULT_BASE_CANDIDATES)
    base_ref = None
    for candidate in base_candidates:
        try:
            _run_git(["rev-parse", "--verify", candidate])
            base_ref = candidate
            break
        except RuntimeError:
            continue
    if base_ref is None:
        print(f"[行数闸门] 基线不可解析（已尝试: {', '.join(base_candidates)}），跳过")
        return 0

    try:
        total, per_file = _collect_added_lines(base_ref)
    except RuntimeError as exc:
        print(f"[行数闸门] git 异常：{exc}")
        return 3

    print(f"[行数闸门] 基线 {base_ref} → HEAD 新增 {total} 行（上限 {args.limit}，"
          f"已排除锁文件/生成物）")
    for added, path in per_file[:5]:
        print(f"  top: +{added:<6} {path}")

    if total <= args.limit:
        return 0

    print(
        f"[行数闸门] ✗ 新增 {total} 行超过上限 {args.limit}。\n"
        "  按任务微型化纪律（实施计划 §4.2）拆分为多轮小步提交；\n"
        "  确需一次性合入时，由 owner 设置 LARGE_PR_APPROVED=1 显式豁免（等同人工说明）。",
    )
    if os.environ.get("LARGE_PR_APPROVED") == "1":
        print("[行数闸门] 检测到 LARGE_PR_APPROVED=1，人工豁免放行。")
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
