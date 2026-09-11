"""接口实调预览服务 — 新增态「一键预填」的后端探测（不依赖已存接口）。

与 MarketDataSyncService.test_single_interface（试调端点）的差异：
- 不依赖已保存的 QuoteInterface：直接按调用方传入的 endpoint（SDK 顶层函数名
  或 HTTPS 相对路径）实调一次，供前端在「新增接口」时预填字段映射行；
- 纯预览：不写库、不计入 consecutive_failures、不做 params 模板生成。

两条探测路径：
- SDK（``preview_sdk_interface``）：懒导入 akshare 实调；
- HTTPS（``preview_https_interface``）：复用 ``MarketDataSyncService._fetch_https_raw``，
  构造一个**不入 session** 的临时 QuoteInterface（字段全部取自请求体），
  从而与生产同步路径共享 SSRF 校验 / response_parse（json、text_split）/
  code_param 与内联 ``q=`` 拼接 / code_prefix 补全，同时不产生 INSERT、
  不计失败计数（失败计数由 fallback_fetch._mark_failure 负责，不在这条路径）。

懒导入 / 超时保护 / DataFrame 拍平与 market_data_sync._fetch_sdk_raw 同模式：
仅调用时 import（未安装不阻断启动），asyncio.to_thread + asyncio.wait_for
施加超时，拍平复用 _flatten_dataframe_records（services 同层跨模块复用，
与既有测试直接引用该私有函数的先例一致）。
"""
from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any, Optional

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.quote_interface import QuoteInterface
from app.services.market_data_sync import MarketDataSyncService, _flatten_dataframe_records

# 新接口尚无 itf.timeout 可用，取固定超时（秒）
PREVIEW_TIMEOUT_SECONDS = 30.0


def _error_result(
    elapsed_ms: float, error: str, http_status: Optional[int] = None
) -> dict[str, Any]:
    """预览失败的统一返回结构（对齐试调端点形态；探测语义不抛 500）。

    ``http_status`` 仅 HTTPS 路径有值（上游真实状态码），SDK 路径保持缺省，
    使两条路径的成功/失败结构与前端契约一致。
    """
    result: dict[str, Any] = {
        "ok": False,
        "status": "error",
        "elapsedMs": elapsed_ms,
        "raw": None,
        "warnings": [],
        "error": error,
    }
    if http_status is not None:
        result["httpStatus"] = http_status
    return result


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


# --------------------------------------------------------------------------- #
# HTTPS 预览：复用 MarketDataSyncService._fetch_https_raw（零重复实现、不入库）
# --------------------------------------------------------------------------- #
def _build_preview_interface(
    provider_id: str,
    endpoint: str,
    response_parse: Optional[dict[str, Any]],
    http_method: Optional[str],
) -> QuoteInterface:
    """按请求体构造「仅用于探测」的临时接口实例（不入 session → 不写库）。

    - id 为合成值，仅供 _guarded_fetch 的限流键使用（rate_limit=None 时不触发限流）；
    - retry_count=0：探测场景不做重试，失败立即回传中文原因；
    - timeout 留空 → _fetch_https_raw 走 DEFAULT_TIMEOUT（与生产一致）。
    """
    return QuoteInterface(
        id=f"preview-{uuid.uuid4().hex}",
        provider_id=provider_id,
        name="（实调预览）",
        endpoint=(endpoint or "").strip(),
        http_method=(http_method or "GET").strip().upper() or "GET",
        response_parse=dict(response_parse or {}),
        enabled=True,
        direction="in",
        retry_count=0,
        rate_limit=None,
    )


def _clean_codes(codes: Optional[list[str]]) -> Optional[list[str]]:
    """探测用代码清洗：去空白与空项；全空视为未填（None → 不拼代码参数）。"""
    if not codes:
        return None
    cleaned = [c.strip() for c in codes if isinstance(c, str) and c.strip()]
    return cleaned or None


def _https_error_message(exc: BaseException) -> str:
    """HTTPS 探测异常 → 中文原因（httpx 原生消息为英文，转译关键几类）。

    配置类错误（缺 base_url / SSRF 拦截）与上游 5xx、401/403 已由
    _fetch_https_raw 抛出中文 ValueError / RuntimeError，此处原样透传。
    """
    if isinstance(exc, httpx.TimeoutException):
        return "请求上游超时：请检查 base_url 与网络连通性，或调大接口超时"
    if isinstance(exc, httpx.ConnectError):
        return f"无法连接上游服务（{exc}）"
    if isinstance(exc, httpx.HTTPStatusError):
        status = getattr(exc.response, "status_code", None)
        if status is not None:
            return f"上游返回 HTTP {status}"
        return f"上游返回异常状态码（{exc}）"
    return str(exc) or type(exc).__name__


async def preview_https_interface(
    session: AsyncSession,
    provider_id: str,
    endpoint: str,
    params: Optional[dict[str, Any]] = None,
    response_parse: Optional[dict[str, Any]] = None,
    http_method: Optional[str] = None,
    codes: Optional[list[str]] = None,
    timeout_seconds: float = PREVIEW_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """按 provider.base_url + endpoint 实调一次 HTTPS 接口（纯预览，不写库）。

    返回结构与 SDK 预览一致：``{ok, status, elapsedMs, raw, rowCount, warnings, error}``，
    额外回传 ``httpStatus``（上游状态码；未拿到响应时为 null）。
    探测语义：缺配置 / SSRF 拦截 / 上游错误 / 网络异常 / 超时全部转 ok:false +
    中文原因，不向调用方抛 500。
    """
    start = time.perf_counter()
    itf = _build_preview_interface(provider_id, endpoint, response_parse, http_method)
    svc = MarketDataSyncService(session)
    try:
        rows = await asyncio.wait_for(
            svc._fetch_https_raw(itf, dict(params or {}), _clean_codes(codes)),
            timeout=timeout_seconds,
        )
    except asyncio.TimeoutError:
        elapsed = round((time.perf_counter() - start) * 1000, 2)
        return _error_result(
            elapsed,
            f"调用超时（{timeout_seconds:g}s）：请检查 base_url 与调用路径，或稍后重试",
            svc._last_http_status,
        )
    except Exception as exc:
        elapsed = round((time.perf_counter() - start) * 1000, 2)
        return _error_result(
            elapsed, _https_error_message(exc), svc._last_http_status
        )
    elapsed = round((time.perf_counter() - start) * 1000, 2)
    return {
        "ok": True,
        "status": "success",
        "elapsedMs": elapsed,
        "raw": rows,
        "rowCount": len(rows),
        "warnings": [],
        "httpStatus": svc._last_http_status,
    }
