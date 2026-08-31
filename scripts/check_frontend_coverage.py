#!/usr/bin/env python3
"""前端覆盖率闸门（架构治理规范 §6）：分层覆盖率低于阈值即打回。

用法：
  python scripts/check_frontend_coverage.py                    # 默认阈值（首期基线留缓冲）
  python scripts/check_frontend_coverage.py --min-src 68       # 覆盖某层阈值
  python scripts/check_frontend_coverage.py --min-modules 65   # 启用 modules 层（首期观察项）
  COVERAGE_APPROVED=1 python scripts/check_frontend_coverage.py  # 人工豁免（放行但醒目打印）

规则：
- 在 ``web/`` 下执行 ``npx vitest run --coverage``，并额外产出 ``json-summary``
  报告；随后解析 ``web/coverage/coverage-summary.json``。
- 只统计 ``src/`` 下的文件（``e2e/``、配置文件、测试辅助目录不进分母）。
  各层覆盖率按**语句数加权**（``sum(covered) / sum(total)``），不对单文件
  覆盖率取简单平均，避免 0% 的大页面文件过度稀释真实覆盖水平。
- 首期阈值按实测基线留缓冲（src/lib 73 / src 整体 65），目标是「现在能通过、
  劣化就拦住」；``src/modules/``（68.21）与 ``src/api/``（51.63，函数覆盖尤低）
  首期为**观察项**，仅在输出中展示，可用 ``--min-modules`` 等参数启用。
- **依赖前置**：需要 ``@vitest/coverage-v8``（已列入 ``web/package.json`` 的
  devDependencies，并在 ``web/knip.json`` 的 ``ignoreDependencies`` 中豁免——
  它以 `provider: 'v8'` 字符串形式被 vitest 引用，静态分析识别不到）。
  主工作树的 node_modules 因 pnpm 环境漂移（建树用 pnpm@11.20.0+isolated，
  当前仅 pnpm 9.15.9 且 .npmrc 声明 hoisted）无法增删依赖，故**本地通常装不到
  该包**；此时脚本直接报「依赖缺失」并退出 3，由 CI（全新环境、pnpm 9）强制执行。
- vitest 本身失败（返回码非 0）→ 退出码 3，且**不**拿失败结果判阈值。唯一例外：
  输出命中 ``SANDBOX_CLEANUP_NOISE`` 特征时，属沙箱清理阶段噪声（测试与报告均已
  产出），按产物继续判定并打印提示；未命中特征一律照常判失败，不做无差别放行。
- 任一受管层低于阈值 → 退出码 2；人工审定后可设环境变量 ``COVERAGE_APPROVED=1``
  显式豁免（与后端 ``check_coverage.py`` 同一风格）。
- 覆盖率报告目录 ``web/coverage`` 为临时产物，脚本结束后删除。

退出码：0 通过（或人工豁免）；2 低于阈值；3 依赖缺失 / vitest 异常。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = REPO_ROOT / "web"
COVERAGE_DIR = WEB_DIR / "coverage"
SUMMARY_FILE = COVERAGE_DIR / "coverage-summary.json"

# 依赖包（本地可能因 pnpm 环境漂移装不到，见 docstring）
COVERAGE_PKG_DIR = WEB_DIR / "node_modules" / "@vitest" / "coverage-v8"

# 首期阈值：按实测基线留缓冲（脚本口径基线 src/lib 80.21 / src 整体 69.14 / modules 68.21）
DEFAULT_MIN_LIB = 73.0
DEFAULT_MIN_SRC = 65.0
DEFAULT_MIN_MODULES: float | None = None  # 观察项：首期不设阈值

# 受管层（按前缀匹配；src 整体单独兜底统计）
LAYER_LIB = "src/lib/"
LAYER_MODULES = "src/modules/"
LAYER_SRC = "src/"

ENV_APPROVED = "COVERAGE_APPROVED"

# 沙箱噪声特征：WorkBuddy 的 safe-delete shim 会拦截 node 的 fs.rm，使 coverage-v8 在
# **报告写完之后**清理 coverage/.tmp 时抛 Unhandled Error（测试本身已全部通过）。
# 仅在本地沙箱出现，CI 无此 shim。故用特征串窄口径识别，避免把环境噪声误判为测试失败；
# 同时绝不无条件忽略非 0 退出码——未命中特征时照常判失败（退出码 3）。
SANDBOX_CLEANUP_NOISE = ("safe-delete", "trash` operation")


@dataclass
class LayerStat:
    """单层的聚合结果：语句总数、已覆盖语句数、文件数、阈值（None = 观察项）。"""

    name: str
    statements: int = 0
    covered: int = 0
    files: int = 0
    threshold: float | None = None

    @property
    def percent(self) -> float:
        if self.statements == 0:
            return 100.0
        return self.covered / self.statements * 100

    @property
    def missing(self) -> int:
        return self.statements - self.covered

    @property
    def passed(self) -> bool:
        if self.threshold is None:
            return True  # 观察项不参与门禁
        return self.percent >= self.threshold

    def to_dict(self) -> dict[str, object]:
        return {
            "layer": self.name,
            "percent_covered": round(self.percent, 2),
            "threshold": self.threshold,
            "covered_statements": self.covered,
            "num_statements": self.statements,
            "missing_statements": self.missing,
            "files": self.files,
            "passed": self.passed,
        }


def _normalize_path(raw: str) -> str | None:
    """把 summary 里的文件路径归一为 ``src/...``；不属于 src 则返回 None。"""
    text = raw.replace("\\", "/")
    marker = "/src/"
    if marker not in text:
        return None
    return "src/" + text.split(marker, 1)[1]


def _resolve(cmd: str) -> str:
    """Windows 下 subprocess 不能直接执行 .cmd（如 npx.cmd）→ 用 which 解析全路径。

    与 ``pre_commit_gate.py`` 的 ``_resolve`` 同一处理：本项目运行在 Windows，
    直接把 "npx" 交给 subprocess 会抛 FileNotFoundError（WinError 2）。
    """
    if os.name == "nt" and not cmd.lower().endswith((".exe", ".cmd", ".bat")):
        found = shutil.which(cmd)
        if found:
            return found
    return cmd


def _run_vitest() -> tuple[int, str]:
    """在 web/ 下跑 vitest 覆盖率；返回 (退出码, 合并后的 stdout+stderr)。

    需要拿到输出文本是因为：WorkBuddy 沙箱会把 node 的 ``fs.rm`` 包裹成回收站操作
    （safe-delete shim），coverage-v8 在**报告写完之后**清理 ``coverage/.tmp`` 时
    会因此抛 Unhandled Error，使 vitest 返回非 0——**测试其实已全部通过、报告也已
    生成**。该现象仅存在于本地沙箱，CI 无此 shim。故交由调用方按特征串识别，
    而不是笼统地把非 0 退出码都当成测试失败。
    """
    result = subprocess.run(
        [
            _resolve("npx"),
            "vitest",
            "run",
            "--coverage",
            "--coverage.reporter=json-summary",
            "--coverage.reporter=text",
        ],
        cwd=WEB_DIR,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        text=True,
    )
    output = f"{result.stdout or ''}\n{result.stderr or ''}"
    sys.stdout.write(result.stdout or "")
    sys.stderr.write(result.stderr or "")
    return result.returncode, output


def _aggregate(files: dict[str, dict]) -> list[LayerStat]:
    """按目录聚合覆盖率（语句数加权）；返回按声明顺序排列的分层统计。"""
    layers: dict[str, LayerStat] = {
        LAYER_LIB: LayerStat(LAYER_LIB),
        LAYER_MODULES: LayerStat(LAYER_MODULES),
        LAYER_SRC: LayerStat(LAYER_SRC),
    }
    for raw_path, payload in files.items():
        if raw_path == "total":
            continue
        normalized = _normalize_path(raw_path)
        if normalized is None:
            continue
        statements = payload.get("statements", {}) or {}
        total = int(statements.get("total", 0) or 0)
        covered = int(statements.get("covered", 0) or 0)
        layers[LAYER_SRC].statements += total
        layers[LAYER_SRC].covered += covered
        layers[LAYER_SRC].files += 1
        for prefix in (LAYER_LIB, LAYER_MODULES):
            if normalized.startswith(prefix):
                layer = layers[prefix]
                layer.statements += total
                layer.covered += covered
                layer.files += 1
                break
    return [layers[LAYER_LIB], layers[LAYER_MODULES], layers[LAYER_SRC]]


def _print_table(stats: list[LayerStat]) -> None:
    """打印分层表格：层 / 覆盖率 / 阈值 / 未覆盖语句数 / 是否达标。"""
    print(f"{'层':<18}{'覆盖率':>9}{'阈值':>10}{'未覆盖语句':>12}{'文件':>7}{'结果':>8}")
    print("-" * 64)
    for stat in stats:
        threshold_text = "观察项" if stat.threshold is None else f"{stat.threshold:.1f}%"
        result_text = "观察" if stat.threshold is None else ("PASS" if stat.passed else "FAIL")
        print(
            f"{stat.name:<18}{stat.percent:>8.2f}%{threshold_text:>10}"
            f"{stat.missing:>12}{stat.files:>7}{result_text:>8}"
        )


def main() -> int:
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except Exception:  # noqa: BLE001 - 纯展示性兜底
            pass

    parser = argparse.ArgumentParser(
        description="前端覆盖率闸门（src/lib 73 / src 整体 65，单位：百分比）",
    )
    parser.add_argument("--min-src", type=float, default=DEFAULT_MIN_SRC, help="src 整体下限")
    parser.add_argument("--min-lib", type=float, default=DEFAULT_MIN_LIB, help="src/lib/ 下限")
    parser.add_argument(
        "--min-modules",
        type=float,
        default=DEFAULT_MIN_MODULES,
        help="src/modules/ 下限；缺省为观察项（不设阈值）",
    )
    parser.add_argument("--json", dest="json_path", default=None, help="另存分层结果 JSON 的路径")
    args = parser.parse_args()

    if not COVERAGE_PKG_DIR.exists():
        print(
            "[前端覆盖率闸门] 未检测到 @vitest/coverage-v8，无法测量覆盖率。\n"
            "  该包已在 web/package.json 与 pnpm-lock.yaml 中登记（CI 全新环境可安装），\n"
            "  但主工作树的 node_modules 因 pnpm 环境漂移无法增删依赖：\n"
            "    建树配置 pnpm@11.20.0 + isolated，当前 pnpm 9.15.9，.npmrc 声明 hoisted。\n"
            "  本闸门由 CI 强制执行（frontend-test 流水线）；本地如需测量，\n"
            "  请在临时副本里用 pnpm 9 全新安装后执行。",
        )
        return 3

    print("[前端覆盖率闸门] 执行 vitest run --coverage（cwd=web）...")
    returncode, output = _run_vitest()
    sandbox_noise = any(marker in output for marker in SANDBOX_CLEANUP_NOISE)
    if returncode != 0 and not sandbox_noise:
        shutil.rmtree(COVERAGE_DIR, ignore_errors=True)
        print("[前端覆盖率闸门] vitest 未通过：覆盖率数据不可信，不据此判定阈值。")
        return 3
    if returncode != 0:
        # 已确认是沙箱清理阶段噪声：报告已产出，继续按产物判定
        print(
            "[前端覆盖率闸门] 注意：vitest 退出码非 0，但识别为沙箱清理噪声\n"
            "  （safe-delete shim 拦截了 coverage/.tmp 的回收，测试与报告均已产出），\n"
            "  按产物继续判定。CI 无此 shim，不会出现该提示。",
        )

    try:
        if not SUMMARY_FILE.exists():
            print(f"[前端覆盖率闸门] 未生成覆盖率报告 {SUMMARY_FILE}，无法判定。")
            return 3
        data = json.loads(SUMMARY_FILE.read_text(encoding="utf-8"))
    finally:
        shutil.rmtree(COVERAGE_DIR, ignore_errors=True)

    stats = _aggregate(data)
    thresholds = {
        LAYER_LIB: args.min_lib,
        LAYER_MODULES: args.min_modules,
        LAYER_SRC: args.min_src,
    }
    for stat in stats:
        stat.threshold = thresholds[stat.name]

    print("\n[前端覆盖率闸门] 分层覆盖率（按语句数加权，仅统计 src/）")
    _print_table(stats)

    if args.json_path:
        out_path = Path(args.json_path)
        if not out_path.is_absolute():
            out_path = REPO_ROOT / out_path
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(
            json.dumps({"layers": [stat.to_dict() for stat in stats]}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"\n[前端覆盖率闸门] 分层结果已写入 {out_path}")

    failed = [stat for stat in stats if not stat.passed]
    if not failed:
        print("\n[前端覆盖率闸门] 通过：各受管层覆盖率均不低于阈值。")
        return 0

    print("\n[前端覆盖率闸门] 以下层覆盖率低于阈值：")
    for stat in failed:
        print(
            f"  - {stat.name}: {stat.percent:.2f}% < {stat.threshold:.1f}%"
            f"（缺 {stat.missing} 条语句，需补 {stat.threshold - stat.percent:.2f}pt）"
        )
    print(
        "  补测优先级：src/lib 为纯逻辑层（无 Vue/DOM 依赖），单测成本最低、收益最高；\n"
        "              其次补各模块 composables；admin 等大页面组件暂列观察项。\n"
        f"  确需临时放行时，由 owner 设置 {ENV_APPROVED}=1 显式豁免（等同人工说明）。",
    )
    if os.environ.get(ENV_APPROVED) == "1":
        print(f"[前端覆盖率闸门] 检测到 {ENV_APPROVED}=1，人工豁免放行。")
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
