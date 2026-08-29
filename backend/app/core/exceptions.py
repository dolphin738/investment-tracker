"""业务异常与全局异常处理器 — 统一把异常转成信封 {code, data, message}。

镜像 app 的 HttpExceptionFilter：
- service 主动抛 BusinessException(code, message, data, status) → 原样透传 code/data；
- 无自定义 code 的 HTTPException → 按状态码映射业务码（HTTP_STATUS_TO_CODE）；
- 校验错误 → 2000；未捕获 → 5000。
data 字段：异常未携带时回落 null（保持既有错误响应形状）。
"""
from __future__ import annotations

import traceback as _traceback
from typing import Any

from fastapi import Request
from fastapi.exceptions import HTTPException as StarletteHTTPException
from fastapi.exceptions import RequestValidationError

from app.core.enums import BusinessErrorCode, CODE_TO_HTTP_STATUS, HTTP_STATUS_TO_CODE
from app.core.envelope import EnvelopeJSONResponse


class BusinessException(Exception):
    """主动抛出的业务异常，携带业务码 + 结构化 data。

    例：raise BusinessException(BusinessErrorCode.PENDING_DELETION, "账户处于注销冷静期",
                               data={"remainingDays": 12}, status_code=409)
    """

    def __init__(
        self,
        code: int,
        message: str,
        data: Any = None,
        status_code: int | None = None,
    ) -> None:
        self.code = int(code)
        self.message = message
        self.data = data
        self.status_code = status_code or CODE_TO_HTTP_STATUS.get(
            self.code, 400
        )
        super().__init__(message)


class AccountPendingDeletionException(BusinessException):
    """账户处于注销冷静期（SYS-P1-02）。

    刻意用 409 而非 401：前端拦截器对 401 会清 token 跳登录，会吃掉冷静期信号。
    安全前提：只有 bcrypt 校验通过后才允许抛出，密码不通过必须统一走 1001（防枚举）。
    """

    def __init__(self, remaining_days: int) -> None:
        super().__init__(
            code=BusinessErrorCode.PENDING_DELETION,
            message="账户处于注销冷静期，请在登录页恢复",
            data={"remainingDays": remaining_days},
            status_code=409,
        )


async def business_exception_handler(
    _request: Request, exc: BusinessException
) -> EnvelopeJSONResponse:
    return EnvelopeJSONResponse(
        {"code": exc.code, "data": exc.data, "message": exc.message},
        status_code=exc.status_code,
    )


async def http_exception_handler(
    _request: Request, exc: StarletteHTTPException
) -> EnvelopeJSONResponse:
    code = HTTP_STATUS_TO_CODE.get(exc.status_code, exc.status_code)
    return EnvelopeJSONResponse(
        {"code": code, "data": None, "message": str(exc.detail)},
        status_code=exc.status_code,
    )


async def validation_exception_handler(
    _request: Request, exc: RequestValidationError
) -> EnvelopeJSONResponse:
    messages = [
        str(err.get("msg", "")) for err in exc.errors() if err.get("msg")
    ]
    message = "; ".join(m for m in messages if m) or "参数校验失败"
    return EnvelopeJSONResponse(
        {
            "code": BusinessErrorCode.VALIDATION_FAILED,
            "data": None,
            "message": message,
        },
        status_code=400,
    )


async def unhandled_exception_handler(
    _request: Request, exc: Exception
) -> EnvelopeJSONResponse:
    # 仅 5xx / 未捕获异常落库（4xx 业务异常走各自的 handler，不在此落库，避免噪音，
    # 见方案 §4.2 评审结论）。本处理器只响应 Exception（即非 BusinessException /
    # HTTPException / validation 的未处理异常），故天然只覆盖 5xx。
    try:
        from app.services.log import record

        await record(
            level="error",
            scope="error",
            module="api",
            message=str(exc),
            trace=_traceback.format_exc(),
        )
    except Exception:
        # 落库本身失败（如 DB 不可用）绝不影响 500 响应
        pass
    return EnvelopeJSONResponse(
        {
            "code": BusinessErrorCode.INTERNAL_ERROR,
            "data": None,
            "message": "服务器内部错误",
        },
        status_code=500,
    )
