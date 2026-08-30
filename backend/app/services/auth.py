"""认证依赖 — 当前用户解析与角色守卫（FastAPI 依赖注入）。

原位于 app/core/security.py（A1 方案乙迁移：core 层不得依赖业务层
services/modules/models，而 ``get_current_user`` 查库依赖 ``app.models.User``，
故连同 ``CurrentUser`` / 角色守卫一并迁至 services 层；core/security.py 仅保留
无业务依赖的纯函数：create_access_token / decode_access_token /
hash_password / verify_password）。

- ``get_current_user``：验签 → 查库确认用户存在且未软删除 → 返回 CurrentUser；
- ``require_any_role`` / ``require_admin``：角色守卫（以 DB 实时 role 为准，
  陈旧 JWT 不绕过被降权用户）。
"""
from __future__ import annotations

import jwt
from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import BusinessErrorCode
from app.core.exceptions import BusinessException
from app.core.security import decode_access_token
from app.db.database import get_db
from app.models import User

# auto_error=False：缺失 token 时我们自己抛 1001，而非 Starlette 的 403
_bearer = HTTPBearer(auto_error=False)


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
    # JWT 吊销校验（REP-011）：token 携带的版本号与库内不一致 → 已改密/改邮箱，须重登。
    # 旧 token 无 tv 声明时按 0 处理，与用户默认版本号对齐（不强制存量用户下线）。
    token_version = payload.get("tv", 0)
    if (user.token_version or 0) != token_version:
        raise BusinessException(
            code=BusinessErrorCode.TOKEN_EXPIRED,
            message="登录状态已失效，请重新登录",
            status_code=403,
        )
    return CurrentUser(user_id=user.id, email=user.email, role=user.role)


def require_any_role(*roles: str):
    """通用角色依赖工厂：返回供 ``Depends(...)`` 使用的角色校验依赖。

    用法：``Depends(require_any_role("admin", "auditor"))``。返回的是依赖函数本身
    （非协程），故 ``Depends(require_any_role("admin"))`` 不会在导入期误调用协程。

    校验当前用户 role 是否在 ``roles`` 内，否则 403。鉴权以数据库实时 role 为准
    （get_current_user 已查库），不信任 JWT payload 的 role 字段——被降权的用户
    持旧 JWT 无法绕过（陈旧 JWT 不绕过）。
    """

    async def _checker(current: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if current.role not in roles:
            raise BusinessException(
                code=BusinessErrorCode.FORBIDDEN,
                message="权限不足",
                status_code=403,
            )
        return current

    return _checker


async def require_admin(
    current: CurrentUser = Depends(require_any_role("admin")),
) -> CurrentUser:
    """管理员权限依赖（require_any_role('admin') 的特例，既有调用方行为不变）。

    鉴权以数据库实时 role 为准（get_current_user 已查库），不信任 JWT payload 的
    role 字段——被降权的管理员持旧 JWT 无法绕过（陈旧 JWT 不绕过）。
    """
    return current
