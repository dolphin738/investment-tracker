"""认证基础设施 — JWT(HS256) + bcrypt 纯函数。

与 app 的 passport-jwt 策略逐字兼容：
- payload { sub: userId, email }，iat/exp 自动；
- bcrypt cost=10；哈希格式跨语言兼容，旧库密码哈希可直接被 Python 校验。

边界（A1 方案乙）：core 层不依赖业务层（services/modules/models）。
依赖注入类（CurrentUser / get_current_user / require_any_role /
require_admin，内部查库依赖 app.models.User）已迁至 app/services/auth.py；
本文件仅保留无业务依赖的纯函数（token 签发/验签、密码哈希）。
"""
from __future__ import annotations

import bcrypt
import jwt
from datetime import datetime, timedelta, timezone

from app.core.config import get_settings

settings = get_settings()


def create_access_token(
    sub: str, email: str, role: str = "user", token_version: int = 0
) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": sub,
        "email": email,
        "role": role,
        "tv": token_version,  # JWT 吊销版本（REP-011）
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
