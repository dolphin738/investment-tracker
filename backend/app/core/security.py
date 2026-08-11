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
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.enums import BusinessErrorCode
from app.core.exceptions import BusinessException
from app.db.database import get_db
from app.models import User

settings = get_settings()

# auto_error=False：缺失 token 时我们自己抛 1001，而非 Starlette 的 403
_bearer = HTTPBearer(auto_error=False)


def create_access_token(sub: str, email: str, role: str = "user") -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": sub,
        "email": email,
        "role": role,
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
    def __init__(self, user_id: str, email: str, role: str = "user") -> None:
        self.user_id = user_id
        self.email = email
        self.role = role


async def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> CurrentUser:
    """受保护路由依赖：解析 Bearer Token 并查库确认用户存在且未软删除。

    鉴权链：验签失败/缺失 → 1001/1002；用户不存在或处于注销冷静期 → 1001
    （统一 1001，不泄露账户枚举信息）。
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
    sub = payload.get("sub")
    user = (
        await db.execute(select(User).where(User.id == sub))
    ).scalar_one_or_none()
    if user is None or user.deleted_at is not None:
        raise BusinessException(
            code=BusinessErrorCode.UNAUTHORIZED,
            message="无效 Token 或账户不可用",
            status_code=401,
        )
    return CurrentUser(user_id=user.id, email=user.email, role=user.role)


async def require_admin(current: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    """管理员权限依赖：当前用户 role 必须为 admin。

    鉴权以数据库实时 role 为准（get_current_user 已查库），不信任 JWT payload 的
    role 字段——被降权的管理员持旧 JWT 无法绕过（陈旧 JWT 不绕过）。
    """
    if current.role != "admin":
        raise BusinessException(
            code=BusinessErrorCode.FORBIDDEN,
            message="需要管理员权限",
            status_code=403,
        )
    return current
