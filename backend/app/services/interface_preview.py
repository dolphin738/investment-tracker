"""接口实调预览服务 — 新增态「一键预填」的后端探测（不依赖已存接口）。

与 MarketDataSyncService.test_single_interface（试调端点）的差异：
- 不依赖已保存的 QuoteInterface：直接按调用方传入的 endpoint（SDK 顶层函数名）
  懒导入 akshare 实调一次，供前端在「新增接口」时预填字段映射行；
- 纯预览：不写库、不计入 consecutive_failures、不做 params 模板生成。

懒导入 / 超时保护 / DataFrame 拍平与 market_data_sync._fetch_sdk_raw 同模式：
仅调用时 import（未安装不阻断启动），asyncio.to_thread + asyncio.wait_for
施加超时，拍平复用 _flatten_dataframe_records（services 同层跨模块复用，
与既有测试直接引用该私有函数的先例一致）。
"""
from __future__ import annotations

import asyncio
import time
from typing import Any, Optional

from app.services.market_data_sync import _flatten_dataframe_records

# 新接口尚无 itf.timeout 可用，取固定超时（秒）
PREVIEW_TIMEOUT_SECONDS = 30.0


def _error_result(elapsed_ms: float, error: str) -> dict[str, Any]:
    """预览失败的统一返回结构（对齐试调端点形态；探测语义不抛 500）。"""
    return {
        "ok": False,
        "status": "error",
        "elapsedMs": elapsed_ms,
        "raw": None,
        "warnings": [],
        "error": error,
    }


async def _call_sdk(
    endpoint: str, params: dict[str, Any], timeout_seconds: float
) -> list[dict]:
    """懒导入 akshare 并实调一次，返回拍平后的原始行。"""
    import akshare  # noqa: PLC0415  懒导入：仅调用时 import（见模块 docstring）

    func = getattr(akshare, endpoint, None)
    if func is None:
        raise ValueError(f"akshare 中不存在函数 {endpoint}")
    # SDK 同步阻塞调用：放入线程并施加超时，避免阻塞事件循环。
    # params 为空 dict 时 func(**{}) 即按 akshare 签名默认值调用。
    df = await asyncio.wait_for(
        asyncio.to_thread(func, **params), timeout=timeout_seconds
    )
    if df is None or getattr(df, "empty", False):
        return []
    if hasattr(df, "to_dict"):
        return _flatten_dataframe_records(df)
    if hasattr(df, "iterrows"):  # 兼容非 pandas DataFrame 替身（测试）
        return [
            (r.to_dict() if hasattr(r, "to_dict") else dict(r))
            for _, r in df.iterrows()
        ]
    return []


async def preview_sdk_interface(
    endpoint: str,
    params: Optional[dict[str, Any]] = None,
    timeout_seconds: float = PREVIEW_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """按 endpoint 懒导入 akshare 实调一次，返回原始行（纯预览，不写库）。

    返回结构对齐试调端点形态：``{ok, status, elapsedMs, raw, warnings, error}``。
    探测语义：实调异常仅包住网络调用并透传错误消息（ok:false），不向调用方抛 500。
    """
    start = time.perf_counter()
    try:
        rows = await _call_sdk(endpoint.strip(), dict(params or {}), timeout_seconds)
    except ImportError:
        elapsed = round((time.perf_counter() - start) * 1000, 2)
        return _error_result(elapsed, "后端未安装 akshare，无法实调预览")
    except asyncio.TimeoutError:
        elapsed = round((time.perf_counter() - start) * 1000, 2)
        return _error_result(
            elapsed,
            f"调用超时（{timeout_seconds:g}s）：请检查函数名与参数，或稍后重试",
        )
    except Exception as exc:  # 探测语义：透传错误消息（空消息回退类型名）
        elapsed = round((time.perf_counter() - start) * 1000, 2)
        return _error_result(elapsed, str(exc) or type(exc).__name__)
    elapsed = round((time.perf_counter() - start) * 1000, 2)
    return {
        "ok": True,
        "status": "success",
        "elapsedMs": elapsed,
        "raw": rows,
        "rowCount": len(rows),
        "warnings": [],
    }
