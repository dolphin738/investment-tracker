#!/usr/bin/env python3
"""覆盖率闸门（架构治理规范 §6 防反弹工程）：分层覆盖率低于阈值即打回。

用法：
  python scripts/check_coverage.py                     # 默认阈值（首期基线留缓冲）
  python scripts/check_coverage.py --min-services 65   # 覆盖某层阈值
  python scripts/check_coverage.py --min-modules 70    # 启用 modules 层（首期为观察项）
  python scripts/check_coverage.py --json build/coverage-gate.json  # 另存分层结果
  COVERAGE_APPROVED=1 python scripts/check_coverage.py # 人工豁免（放行但醒目打印）

规则：
- 在 ``backend/`` 下执行 ``uv run pytest --cov=app --cov-report=json:<临时文件> -q``，
  只统计 ``app`` 包（``backend/tests/`` 不进分母），随后解析 coverage.py 的 JSON 产物
  （``totals`` 与 ``files.<path>.summary``）。
- JSON 中的文件路径可能是绝对路径也可能是相对路径 → 统一相对化到 ``app/...`` 再按
  前缀归类（Windows 反斜杠一并归一）。
- 按目录聚合四层：``app/finance_core/``、``app/services/``、``app/modules/``、
  以及 ``app`` 整体。覆盖率按**语句数加权**
  （``sum(covered_lines) / sum(num_statements)``），不对单文件覆盖率取简单平均，
  避免小文件稀释或放大真实覆盖水平。
- 首期阈值按真实基线留缓冲（finance_core 90 / services 60 / app 70），目标是
  「现在能通过、劣化就拦住」，而不是一上来全面 fail；``app/modules/`` 首期不设阈值，
  仅在输出中展示作为观察项（可用 ``--min-modules`` 启用）。
- pytest 本身失败（返回码非 0）→ 退出码 3，且**不**拿失败结果判阈值：测试挂掉时
  覆盖率数据不可信。
- 任一受管层低于阈值 → 退出码 2；人工审定后可设环境变量 ``COVERAGE_APPROVED=1``
  显式豁免（与 ``scripts/check_line_budget.py`` 的 ``LARGE_PR_APPROVED=1`` 同一风格，
  豁免动作本身即「人工说明」的落点）。
- 覆盖率 JSON 为临时产物，用 try/finally 保证删除，不留在工作树。

退出码：0 通过（或人工豁免）；2 低于阈值；3 pytest 执行异常。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = REPO_ROOT / "backend"

# 首期阈值：按真实基线留缓冲（基线 finance_core 96.1 / services 62.9 / app 73.3）
DEFAULT_MIN_FINANCE_CORE = 90.0
DEFAULT_MIN_SERVICES = 60.0
DEFAULT_MIN_APP = 70.0
DEFAULT_MIN_MODULES: float | None = None  # 观察项：首期不设阈值

# 受管层（按前缀匹配；app 整体单独兜底统计）
LAYER_FINANCE_CORE = "app/finance_core/"
LAYER_SERVICES = "app/services/"
LAYER_MODULES = "app/modules/"
LAYER_APP = "app/"

ENV_APPROVED = "COVERAGE_APPROVED"


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
            "covered_lines": self.covered,
            "num_statements": self.statements,
            "missing_lines": self.missing,
            "files": self.files,
            "passed": self.passed,
        }


def _normalize_path(raw: str) -> str | None:
    """把 coverage JSON 里的文件路径归一为 ``app/...``；不属于 app 包则返回 None。"""
    path = Path(raw)
    if not path.is_absolute():
        path = BACKEND_DIR / path
    try:
        rel = path.resolve().relative_to(BACKEND_DIR.resolve())
    except ValueError:
        try:
            # resolve() 可能因符号链接/大小写差异失败 → 退回纯文本相对化
            rel = Path(os.path.relpath(str(path).replace("\\", "/"), str(BACKEND_DIR)))
        except ValueError:
            return None
    normalized = rel.as_posix().lstrip("./")
    if not (normalized == "app" or normalized.startswith("app/")):
        return None
    return normalized


def _run_pytest(cov_json: Path) -> int:
    """在 backend/ 下跑 pytest 并产出覆盖率 JSON；返回 pytest 退出码。"""
    result = subprocess.run(
        [
            "uv",
            "run",
            "pytest",
            "--cov=app",
            f"--cov-report=json:{cov_json}",
            "-q",
        ],
        cwd=BACKEND_DIR,
        encoding="utf-8",
        errors="replace",
    )
    return result.returncode


def _aggregate(files: dict[str, dict]) -> list[LayerStat]:
    """按目录聚合覆盖率（语句数加权）；返回按声明顺序排列的分层统计。"""
    layers: dict[str, LayerStat] = {
        LAYER_FINANCE_CORE: LayerStat(LAYER_FINANCE_CORE),
        LAYER_SERVICES: LayerStat(LAYER_SERVICES),
        LAYER_MODULES: LayerStat(LAYER_MODULES),
        LAYER_APP: LayerStat(LAYER_APP),
    }
    for raw_path, payload in files.items():
        normalized = _normalize_path(raw_path)
        if normalized is None:
            continue  # tests/ 等非 app 包文件不进分母
        summary = payload.get("summary", {}) or {}
        statements = int(summary.get("num_statements", 0) or 0)
        covered = int(summary.get("covered_lines", 0) or 0)
        layers[LAYER_APP].statements += statements
        layers[LAYER_APP].covered += covered
        layers[LAYER_APP].files += 1
        for prefix in (LAYER_FINANCE_CORE, LAYER_SERVICES, LAYER_MODULES):
            if normalized.startswith(prefix):
                layer = layers[prefix]
                layer.statements += statements
                layer.covered += covered
                layer.files += 1
                break
    return [layers[LAYER_FINANCE_CORE], layers[LAYER_SERVICES],
            layers[LAYER_MODULES], layers[LAYER_APP]]


def _print_table(stats: list[LayerStat]) -> None:
    """打印分层表格：层 / 覆盖率 / 阈值 / 未覆盖语句数 / 是否达标。"""
    print(f"{'层':<22}{'覆盖率':>9}{'阈值':>10}{'未覆盖语句':>12}{'文件':>7}{'结果':>8}")
    print("-" * 68)
    for stat in stats:
        threshold_text = "观察项" if stat.threshold is None else f"{stat.threshold:.1f}%"
        result_text = "PASS" if stat.passed else "FAIL"
        if stat.threshold is None:
            result_text = "观察"
        print(
            f"{stat.name:<22}{stat.percent:>8.2f}%{threshold_text:>10}"
            f"{stat.missing:>12}{stat.files:>7}{result_text:>8}"
        )


def main() -> int:
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except Exception:  # noqa: BLE001 - 纯展示性兜底
            pass

    parser = argparse.ArgumentParser(
        description="覆盖率闸门（app 整体 70 / services 60 / finance_core 90，单位：百分比）",
    )
    parser.add_argument("--min-app", type=float, default=DEFAULT_MIN_APP, help="app 整体下限")
    parser.add_argument(
        "--min-services", type=float, default=DEFAULT_MIN_SERVICES, help="app/services/ 下限"
    )
    parser.add_argument(
        "--min-finance-core",
        type=float,
        default=DEFAULT_MIN_FINANCE_CORE,
        help="app/finance_core/ 下限",
    )
    parser.add_argument(
        "--min-modules",
        type=float,
        default=DEFAULT_MIN_MODULES,
        help="app/modules/ 下限；缺省为观察项（不设阈值）",
    )
    parser.add_argument("--json", dest="json_path", default=None, help="另存分层结果 JSON 的路径")
    args = parser.parse_args()

    handle = tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", prefix=".cov-gate-", dir=BACKEND_DIR, delete=False
    )
    cov_json = Path(handle.name)
    handle.close()
    try:
        print(f"[覆盖率闸门] 执行 pytest（cwd=backend，--cov=app）...")
        returncode = _run_pytest(cov_json)
        if returncode != 0:
            print(
                f"[覆盖率闸门] pytest 未通过（退出码 {returncode}）：覆盖率数据不可信，"
                "不据此判定阈值。",
            )
            return 3
        if not cov_json.exists():
            print("[覆盖率闸门] 未生成覆盖率 JSON，无法判定。")
            return 3
        data = json.loads(cov_json.read_text(encoding="utf-8"))
    finally:
        # 临时产物绝不留在工作树：JSON 报告 + pytest-cov 顺带生成的 .coverage 数据文件
        cov_json.unlink(missing_ok=True)
        (BACKEND_DIR / ".coverage").unlink(missing_ok=True)

    stats = _aggregate(data.get("files", {}) or {})
    thresholds = {
        LAYER_FINANCE_CORE: args.min_finance_core,
        LAYER_SERVICES: args.min_services,
        LAYER_MODULES: args.min_modules,
        LAYER_APP: args.min_app,
    }
    for stat in stats:
        stat.threshold = thresholds[stat.name]

    print("\n[覆盖率闸门] 分层覆盖率（按语句数加权，仅统计 app 包）")
    _print_table(stats)

    if args.json_path:
        out_path = Path(args.json_path)
        if not out_path.is_absolute():
            out_path = REPO_ROOT / out_path
        out_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "totals": data.get("totals", {}),
            "layers": [stat.to_dict() for stat in stats],
        }
        out_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"\n[覆盖率闸门] 分层结果已写入 {out_path}")

    failed = [stat for stat in stats if not stat.passed]
    if not failed:
        print("\n[覆盖率闸门] 通过：各受管层覆盖率均不低于阈值。")
        return 0

    print("\n[覆盖率闸门] 以下层覆盖率低于阈值：")
    for stat in failed:
        print(
            f"  - {stat.name}: {stat.percent:.2f}% < {stat.threshold:.1f}%"
            f"（缺 {stat.missing} 条语句，需补 {stat.threshold - stat.percent:.2f}pt）"
        )
    print(
        "  补测优先级：先补 finance_core/services 的核心链路单测；\n"
        f"  确需临时放行时，由 owner 设置 {ENV_APPROVED}=1 显式豁免（等同人工说明）。",
    )
    if os.environ.get(ENV_APPROVED) == "1":
        print(f"[覆盖率闸门] 检测到 {ENV_APPROVED}=1，人工豁免放行。")
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
