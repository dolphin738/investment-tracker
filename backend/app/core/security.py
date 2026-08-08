"""认证基础设施 — JWT(HS256) + bcrypt + 当前用户依赖。

与 app 的 passport-jwt 策略逐字兼容：
- payload { sub: userId, email }，iat/exp 自动；
- 每个受保护请求：验签 → （Phase 1 查库确认用户存在且未软删除）→ 否则 1001；
- bcrypt cost=10；哈希格式跨语言兼容，旧库密码哈希可直接被 Python 校验。
"""
from __future__ import annotations

import bcrypt
import jwt
from datetime import datetime, timedelta, timezone

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config import get_settings
from app.core.enums import BusinessErrorCode
from app.core.exceptions import BusinessException

settings = get_settings()

# auto_error=False：缺失 token 时我们自己抛 1001，而非 Starlette 的 403
_bearer = HTTPBearer(auto_error=False)


def create_access_token(sub: str, email: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": sub,
        "email": email,
        "iat": now,
        "exp": now + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def decode_access_token(token: str) -> dict:
    return jwt.decode(
        token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM]
    )


def hash_password(password: str) -> str:
    # 直接调用 bcrypt（pin 版本），不走 passlib，规避 4.x 版本坑
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=10)).decode(
        "utf-8"
    )


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(
        password.encode("utf-8"), hashed.encode("utf-8")
    )


class CurrentUser:
    def __init__(self, user_id: str, email: str) -> None:
        self.user_id = user_id
        self.email = email


async def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> CurrentUser:
    """受保护路由依赖：解析 Bearer Token 并返回当前用户。

    TODO(Phase 1): 验签后查库确认用户存在且 deletedAt 为空，否则抛 1001。
    当前 Phase 0 仅做 JWT 验签（无 DB），足以验证信封/错误码/JWT 契约。
    """
    if creds is None:
        raise BusinessException(
            code=BusinessErrorCode.UNAUTHORIZED,
            message="未认证或 Token 缺失",
            status_code=401,
        )
    try:
        payload = decode_access_token(creds.credentials)
    except jwt.ExpiredSignatureError:
        raise BusinessException(
            code=BusinessErrorCode.TOKEN_EXPIRED,
            message="Token 已过期，请重新登录",
            status_code=403,
        )
    except jwt.PyJWTError:
        raise BusinessException(
            code=BusinessErrorCode.UNAUTHORIZED,
            message="无效 Token",
            status_code=401,
        )
    return CurrentUser(user_id=payload["sub"], email=payload.get("email", ""))
