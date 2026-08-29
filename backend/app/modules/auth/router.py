"""认证路由 — 对齐 docs/ARCHITECTURE.md §4.2.1。

公开：register / login / account/restore。受保护：me / profile。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.enums import BusinessErrorCode
from app.core.envelope import EnvelopeRoute
from app.core.exceptions import BusinessException
from app.core import rate_limit
from app.core.security import CurrentUser, get_current_user
from app.db.database import get_db
from app.schemas import (
    EmailPatchReq,
    LoginReq,
    PasswordPatchReq,
    ProfilePatchReq,
    RegisterReq,
    RestoreReq,
)
from app.serializers import serialize_user
from app.services.user import UserService
from app.schemas_resp import AuthTokenOut, UserPublicOut

router = APIRouter(prefix="/api/auth", tags=["auth"], route_class=EnvelopeRoute)


@router.post("/register", response_model=UserPublicOut)
async def register(
    req: RegisterReq, request: Request, db: AsyncSession = Depends(get_db)
) -> dict:
    if not get_settings().REGISTRATION_ENABLED:
        raise BusinessException(
            code=BusinessErrorCode.FORBIDDEN,
            message="当前部署已关闭公开注册",
            status_code=403,
        )
    user = await UserService(db).register(req.email, req.password, req.name)
    return serialize_user(user)


@router.post("/login", response_model=AuthTokenOut)
async def login(
    req: LoginReq, request: Request, db: AsyncSession = Depends(get_db)
) -> dict:
    settings = get_settings()
    ip = request.client.host if request.client else "unknown"
    email = (req.email or "").lower()
    # 登录失败限速（REP-010）：达上限直接 429，阻断爆破/枚举
    if rate_limit.is_limited(
        ip,
        email,
        settings.LOGIN_RATE_LIMIT_PER_MINUTE,
        settings.LOGIN_RATE_LIMIT_WINDOW_SECONDS,
    ):
        raise BusinessException(
            code=BusinessErrorCode.RATE_LIMITED,
            message="登录尝试过于频繁，请稍后再试",
            status_code=429,
        )
    try:
        user = await UserService(db).authenticate(req.email, req.password)
    except BusinessException as exc:
        if exc.status_code == 401:
            rate_limit.record_failure(ip, email)
        raise
    rate_limit.reset(ip, email)
    token = UserService.issue_token(user)
    return {
        "accessToken": token,
        "user": serialize_user(user),
    }


@router.post("/account/restore", response_model=AuthTokenOut)
async def restore(req: RestoreReq, db: AsyncSession = Depends(get_db)) -> dict:
    user = await UserService(db).restore(req.email, req.password)
    token = UserService.issue_token(user)
    return {
        "accessToken": token,
        "user": serialize_user(user),
    }


@router.get("/me", response_model=UserPublicOut)
async def me(
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    u = await UserService(db).get_profile(user.user_id)
    return serialize_user(u)


@router.get("/profile", response_model=UserPublicOut)
async def get_profile(
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """当前用户完整资料（Web 客户端绑定此路径读取当前用户）。

    返回 id/email/name/avatar/phone/bio/role/createdAt，与 PATCH /profile 对称。
    读操作收口到 UserService.get_profile，router 仅做序列化。
    """
    u = await UserService(db).get_profile(user.user_id)
    return serialize_user(u)


@router.patch("/profile", response_model=UserPublicOut)
async def profile(
    req: ProfilePatchReq,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    u = await UserService(db).update_profile(
        user.user_id, req.name, req.avatar, req.phone, req.bio
    )
    return serialize_user(u)


@router.patch("/password", response_model=AuthTokenOut)
async def change_password(
    req: PasswordPatchReq,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    u = await UserService(db).change_password(
        user.user_id, req.currentPassword, req.newPassword
    )
    return {
        "accessToken": UserService.issue_token(u),
        "user": serialize_user(u),
    }


@router.patch("/email", response_model=AuthTokenOut)
async def change_email(
    req: EmailPatchReq,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    u = await UserService(db).change_email(
        user.user_id, req.currentPassword, req.newEmail
    )
    return {
        "accessToken": UserService.issue_token(u),
        "user": serialize_user(u),
    }


@router.delete("/account")
async def delete_account(
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    await UserService(db).delete_account(user.user_id)
    return None
