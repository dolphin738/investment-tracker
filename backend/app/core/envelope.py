"""响应信封 + Decimal 字符串化 + 自定义 APIRoute。

契约（镜像 NestJS ResponseInterceptor + HttpExceptionFilter）：
- 成功：{ code: 0, data: <原值>, message: "ok" }
- 已是信封（带 number 型 code，如 upload 手工信封）→ 原样透传，不二次包裹
- data 为 None/undefined → 归一为 null（前端解包稳定）
- Decimal 序列化为字符串（防金额精度/类型漂移）
- 自定义 JSONResponse：endpoint 直接返回 Response 时 FastAPI 原样使用，
  故信封包装在 EnvelopeRoute 内完成，绕开 FastAPI 的 jsonable_encoder（避免 Decimal→float）。

openapi.json / docs 路由不包裹信封，保证 Swagger UI 能正常加载 schema。
"""
from __future__ import annotations

import functools
import inspect
import json
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Any
from uuid import UUID

from fastapi.routing import APIRoute
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel


def decimal_jsonable_encoder(obj: Any) -> Any:
    """Decimal 安全的 JSON 编码器（替代 fastapi 默认，避免 Decimal→float）。"""
    if isinstance(obj, Decimal):
        return str(obj)
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, UUID):
        return str(obj)
    if isinstance(obj, Enum):
        return obj.value
    if isinstance(obj, BaseModel):
        return decimal_jsonable_encoder(obj.model_dump(mode="json"))
    if isinstance(obj, dict):
        return {k: decimal_jsonable_encoder(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set, frozenset)):
        return [decimal_jsonable_encoder(v) for v in obj]
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    if hasattr(obj, "model_dump"):
        return decimal_jsonable_encoder(obj.model_dump(mode="json"))
    return str(obj)


class EnvelopeJSONResponse(JSONResponse):
    """自带 Decimal→str 编码的信封响应；endpoint 直接返回它时 FastAPI 原样使用。"""

    def render(self, content: Any) -> bytes:
        return json.dumps(
            decimal_jsonable_encoder(content), ensure_ascii=False
        ).encode("utf-8")


def _is_envelope(obj: Any) -> bool:
    """已是响应信封（带 number 型 code 字段）→ 跳过二次包裹。"""
    return (
        isinstance(obj, dict)
        and "code" in obj
        and isinstance(obj.get("code"), int)
    )


def _to_envelope_response(raw: Any) -> Any:
    # 已是 Response（如 FileResponse 头像 / 错误响应 / 手工信封）→ 原样返回
    if isinstance(raw, Response):
        return raw
    # 手动返回的信封（upload 等）→ 透传，不二次包裹
    if _is_envelope(raw):
        return EnvelopeJSONResponse(raw)
    # 正常数据 → 包成统一信封，None 归一为 null
    return EnvelopeJSONResponse(
        {"code": 0, "data": (None if raw is None else raw), "message": "ok"}
    )


def _wrap_endpoint(ep: Any) -> Any:
    is_async = inspect.iscoroutinefunction(ep)

    @functools.wraps(ep)
    async def wrapper(*args: Any, **kwargs: Any) -> Any:
        raw = await ep(*args, **kwargs) if is_async else ep(*args, **kwargs)
        return _to_envelope_response(raw)

    # 让 inspect.signature 看到原参数（依赖注入正常），但去掉返回注解：
    # 否则 FastAPI 会把原函数返回类型（如 AmountDTO，定义在调用方模块）当成
    # 本模块的 forward ref 解析失败。显式 __signature__ 会短路 __wrapped__ 跟随。
    # 响应由 EnvelopeJSONResponse 自行序列化，不依赖 FastAPI response_model。
    sig = inspect.signature(ep)
    wrapper.__signature__ = sig.replace(return_annotation=inspect.Signature.empty)
    return wrapper


# 不包裹信封的系统路由（Swagger 需要原始 schema / HTML）
_SKIP_ENVELOPE_PATHS = {"/api/openapi.json", "/api/docs", "/api/redoc"}


class EnvelopeRoute(APIRoute):
    """自动把 handler 返回值包成信封的 APIRoute。

    在构建 dependant 之前包裹 endpoint，确保依赖注入与 OpenAPI 推断正常；
    openapi/docs 路由保持原样（返回原始 schema/HTML）。
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        path = kwargs.get("path") or (args[0] if args else None)
        if str(path) not in _SKIP_ENVELOPE_PATHS:
            endpoint = kwargs.get("endpoint")
            if endpoint is None and len(args) > 1:
                endpoint = args[1]
            if endpoint is not None:
                kwargs["endpoint"] = _wrap_endpoint(endpoint)
        super().__init__(*args, **kwargs)
