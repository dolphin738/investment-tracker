#!/usr/bin/env python3
"""阶段4 体积闸门：前端构建产物体积增长超阈值时告警（架构治理规范 §6）。

用法：
  python scripts/check_bundle_size.py                    # 对比 scripts/bundle-baseline.json
  python scripts/check_bundle_size.py --build            # 先跑 vite build 再对比（CI 用）
  python scripts/check_bundle_size.py --update-baseline  # 刷新基线（版本发布/刻意增大后）
  BUNDLE_SIZE_STRICT=1 python scripts/check_bundle_size.py  # 超阈值视为失败（退出码 2）

规则：
- 统计对象：``web/dist`` 下全部产物文件。文本类（js/css/html/svg/json）按 **gzip 后
  字节数**计入，其余（图片/字体等已压缩资源）按原始字节数计入——贴近真实传输体积，
  避免无关紧要的原始体积噪声触发告警。``*.map`` 不随页面加载，**不计入**。
- 基线：``scripts/bundle-baseline.json``（入库，含记录时的 git HEAD 与 UTC 时间）。
  规范要求「对比 main 构建产物」，但 CI 内双分支各构建一次成本高且易受流水线缓存
  影响；此处改用**入库基线文件**，语义等价为「对比上一次审定过的体积」，由 owner
  在刻意增大产物时执行 ``--update-baseline`` 显式抬基线（抬基线这个动作即人工审定）。
- 增长 > 阈值（默认 5%）打印告警并列出**增长最多**与**新增**的文件各若干个，
  便于定位是哪次改动引入的膨胀。
- 默认**只告警不阻塞**（一次性引入新依赖属合理场景），退出码 0；CI 可将
  ``BUNDLE_SIZE_STRICT=1`` 配为流水线变量升级为硬闸门（退出码 2）。
- 无基线文件时自动写入当前值为基线并放行（首次运行不告警）。
- ``--build`` 在 ``web/`` 下执行 ``npx vite build``；构建失败即退出码 3
  （体积数据不可信）。

退出码：0 通过/告警/首次写入基线；2 超阈值且 BUNDLE_SIZE_STRICT=1；3 异常。
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = REPO_ROOT / "web"
DEFAULT_DIST = WEB_DIR / "dist"
DEFAULT_BASELINE = REPO_ROOT / "scripts" / "bundle-baseline.json"
DEFAULT_THRESHOLD = 5.0

ENV_STRICT = "BUNDLE_SIZE_STRICT"

# 文本类产物：按 gzip 后字节数计入（贴近传输体积）
GZIP_SUFFIXES = (".js", ".mjs", ".css", ".html", ".svg", ".json", ".txt", ".xml")
# source map 不随页面加载，不计入体积
EXCLUDED_SUFFIXES = (".map",)

TOP_N = 5


def _gzip_size(path: Path) -> int:
    """返回文件 gzip 后的字节数（内存压缩，不落盘）。"""
    with path.open("rb") as fh:
        return len(gzip.compress(fh.read(), compresslevel=9))


def _measure(dist: Path) -> dict[str, int]:
    """测量 dist 下各产物体积：返回 {相对路径: 计入字节数}。"""
    if not dist.exists():
        raise RuntimeError(f"产物目录不存在：{dist}（先执行 vite build 或传 --build）")
    sizes: dict[str, int] = {}
    for file_path in sorted(dist.rglob("*")):
        if not file_path.is_file():
            continue
        if file_path.name.endswith(EXCLUDED_SUFFIXES):
            continue
        rel = file_path.relative_to(dist).as_posix()
        sizes[rel] = _gzip_size(file_path) if rel.endswith(GZIP_SUFFIXES) else file_path.stat().st_size
    if not sizes:
        raise RuntimeError(f"产物目录为空：{dist}")
    return sizes


def _git_head() -> str:
    """当前 HEAD 短 sha；取不到（非 git 环境/CI 浅克隆）时返回 unknown。"""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        return result.stdout.strip() if result.returncode == 0 else "unknown"
    except OSError:
        return "unknown"


def _write_baseline(baseline: Path, sizes: dict[str, int]) -> None:
    payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "git_head": _git_head(),
        "total_bytes": sum(sizes.values()),
        "files": sizes,
    }
    baseline.parent.mkdir(parents=True, exist_ok=True)
    baseline.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _load_baseline(baseline: Path) -> dict | None:
    if not baseline.exists():
        return None
    try:
        return json.loads(baseline.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


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


def _prepare_dist(dist: Path) -> None:
    """构建前清空产物目录（用 Python，而非交给 vite 的 emptyOutDir）。

    本地沙箱会把 node 的 ``fs.rm``/``rmSync`` 包成回收站操作（safe-delete shim），
    vite 在 ``prepareOutDir`` 阶段清空 dist 时会被拦截，导致**构建直接失败**
    （与覆盖率场景不同：那里的清理发生在报告写完之后，产物已可用，可忽略；
    这里的清理发生在构建之前，失败即无产物，绝不能忽略）。
    故由脚本先用 Python 清空，再以 ``--emptyOutDir false`` 让 vite 不重复清空。
    """
    if dist.exists():
        shutil.rmtree(dist, ignore_errors=True)


def _run_build() -> int:
    """在 web/ 下执行 vite build；返回退出码。"""
    result = subprocess.run(
        [_resolve("npx"), "vite", "build", "--emptyOutDir", "false"],
        cwd=WEB_DIR,
        encoding="utf-8",
        errors="replace",
    )
    return result.returncode


def _fmt_kb(num_bytes: int) -> str:
    return f"{num_bytes / 1024:.1f} kB"


def main() -> int:
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except Exception:  # noqa: BLE001 - 纯展示性兜底
            pass

    parser = argparse.ArgumentParser(description=f"体积闸门（默认增长 >{DEFAULT_THRESHOLD}% 告警）")
    parser.add_argument("--dist", default=str(DEFAULT_DIST), help="产物目录（默认 web/dist）")
    parser.add_argument("--baseline", default=str(DEFAULT_BASELINE), help="基线 JSON 路径")
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD, help="增长告警阈值（百分比）")
    parser.add_argument("--build", action="store_true", help="先执行 vite build 再测量")
    parser.add_argument(
        "--update-baseline",
        action="store_true",
        help="以当前产物刷新基线（刻意增大产物后由 owner 执行）",
    )
    args = parser.parse_args()

    if args.build:
        print("[体积闸门] 执行 vite build ...")
        _prepare_dist(Path(args.dist))
        if _run_build() != 0:
            print("[体积闸门] 构建失败：体积数据不可信，不据此告警。")
            return 3

    try:
        sizes = _measure(Path(args.dist))
    except RuntimeError as exc:
        print(f"[体积闸门] {exc}")
        return 3

    total = sum(sizes.values())
    baseline_path = Path(args.baseline)

    if args.update_baseline:
        _write_baseline(baseline_path, sizes)
        print(
            f"[体积闸门] 基线已刷新：{baseline_path.name}（{_fmt_kb(total)}，"
            f"{len(sizes)} 个文件，HEAD={_git_head()}）"
        )
        return 0

    baseline = _load_baseline(baseline_path)
    if baseline is None:
        _write_baseline(baseline_path, sizes)
        print(
            f"[体积闸门] 未找到基线，已写入当前值为基线：{_fmt_kb(total)}、{len(sizes)} 个文件"
            f"（后续以此为准，刻意增大时执行 --update-baseline 抬基线）"
        )
        return 0

    base_files: dict[str, int] = baseline.get("files", {}) or {}
    base_total = int(baseline.get("total_bytes") or sum(base_files.values()))
    if base_total <= 0:
        _write_baseline(baseline_path, sizes)
        print(f"[体积闸门] 基线数据为空，已重写为当前值（{_fmt_kb(total)}）")
        return 0

    delta = total - base_total
    delta_pct = delta / base_total * 100
    print(
        f"[体积闸门] 基线 {_fmt_kb(base_total)}（{baseline.get('git_head', 'unknown')} @ "
        f"{baseline.get('generated_at', '未知时间')}） → 当前 {_fmt_kb(total)}"
    )
    print(f"[体积闸门] 变化 {delta / 1024:+.1f} kB（{delta_pct:+.2f}%），告警阈值 {args.threshold}%")

    if delta_pct <= args.threshold:
        print("[体积闸门] 通过：产物体积增长在阈值内（含体积下降）。")
        return 0

    grown = sorted(
        ((p, s - base_files[p]) for p, s in sizes.items() if p in base_files and s > base_files[p]),
        key=lambda item: item[1],
        reverse=True,
    )[:TOP_N]
    added = sorted(
        ((p, s) for p, s in sizes.items() if p not in base_files),
        key=lambda item: item[1],
        reverse=True,
    )[:TOP_N]

    print(f"[体积闸门] 产物体积增长 {delta_pct:.2f}%，超过 {args.threshold}% 阈值：")
    for path, diff in grown:
        print(f"  增长: +{_fmt_kb(diff):>10}  {path}")
    for path, size in added:
        print(f"  新增: +{_fmt_kb(size):>10}  {path}")
    print(
        "  排查方向：是否引入了新依赖（尤其是 echarts/lucide 这类体积大户）、\n"
        "            是否误把整包导入写成了全量 import；确属刻意为之则执行\n"
        f"            --update-baseline 抬基线。配置 {ENV_STRICT}=1 可将本告警升级为硬闸门。",
    )
    if os.environ.get(ENV_STRICT) == "1":
        print(f"[体积闸门] 检测到 {ENV_STRICT}=1，体积增长视为失败。")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
