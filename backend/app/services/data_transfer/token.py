"""数据导入导出 —— 预览 token 签发 / 校验。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import jwt

from app.core.enums import BusinessErrorCode
from app.core.exceptions import BusinessException

from ._constants import TOKEN_TTL_MIN, settings

__all__ = ["make_token", "decode_token"]


def make_token(type_: str, portfolio_id: str, valid_rows: list[dict], min_date: str | None) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "purpose": "dt_import",
        "type": type_,
        "portfolio_id": portfolio_id,
        "rows": valid_rows,
        "min_date": min_date,
        "iat": now,
        "exp": now + timedelta(minutes=TOKEN_TTL_MIN),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message="导入令牌已过期，请重新预览",
            status_code=400,
        )
    except jwt.PyJWTError:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message="导入令牌无效",
            status_code=400,
        )
