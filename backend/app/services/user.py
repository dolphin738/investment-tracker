"""用户服务 — 注册 / 登录 / 注销恢复（含 30 天冷静期信号）。

对齐 docs/ARCHITECTURE.md §4.2.1：
- 登录冷静期：deletedAt 非空且未超保留期 → 1007 + data.remainingDays（409，非 401）；
  超期 → 1009（410）。
- 邮箱/密码错误 → 一律 1001（不泄露账户枚举）。
- 仅 bcrypt 校验通过后才允许抛 1007/1008/1009（防枚举）。
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import (
    ACCOUNT_RETENTION_DAYS,
    BusinessErrorCode,
)
from app.core.exceptions import (
    AccountPendingDeletionException,
    BusinessException,
)
from app.core.security import create_access_token, hash_password, verify_password
from app.models import User, UserPreference


class UserService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def register(self, email: str, password: str, name: str | None) -> User:
        existing = (
            await self.session.execute(select(User).where(User.email == email))
        ).scalar_one_or_none()
        if existing is not None:
            raise BusinessException(
                code=BusinessErrorCode.EMAIL_TAKEN,
                message="邮箱已被注册",
                status_code=409,
            )
        user = User(email=email, password_hash=hash_password(password), name=name)
        self.session.add(user)
        await self.session.flush()
        # 自动建默认偏好（对齐 app 行为）
        self.session.add(UserPreference(user_id=user.id))
        await self.session.commit()
        await self.session.refresh(user)
        return user

    async def authenticate(self, email: str, password: str) -> User:
        user = (
            await self.session.execute(select(User).where(User.email == email))
        ).scalar_one_or_none()
        # 密码错误路径必须先验密再判定，避免枚举；不存在的用户用假值校验
        if user is None or not verify_password(password, user.password_hash):
            raise BusinessException(
                code=BusinessErrorCode.UNAUTHORIZED,
                message="邮箱或密码错误",
                status_code=401,
            )
        if user.deleted_at is not None:
            self._assert_restore_window(user)
        return user

    async def restore(self, email: str, password: str) -> User:
        user = (
            await self.session.execute(select(User).where(User.email == email))
        ).scalar_one_or_none()
        if user is None or not verify_password(password, user.password_hash):
            raise BusinessException(
                code=BusinessErrorCode.UNAUTHORIZED,
                message="邮箱或密码错误",
                status_code=401,
            )
        if user.deleted_at is None:
            raise BusinessException(
                code=BusinessErrorCode.ACCOUNT_NOT_DELETED,
                message="账户未注销，无需恢复",
                status_code=409,
            )
        # 仍在冷静期 → 可恢复；超期 → 1009
        if datetime.now(timezone.utc) >= user.deleted_at + timedelta(
            days=ACCOUNT_RETENTION_DAYS
        ):
            raise BusinessException(
                code=BusinessErrorCode.RESTORE_EXPIRED,
                message="注销冷静期已过，数据不可找回",
                status_code=410,
            )
        user.deleted_at = None
        await self.session.commit()
        await self.session.refresh(user)
        return user

    async def change_password(
        self, user_id: str, current_password: str, new_password: str
    ) -> User:
        """改密码：校验当前密码 → 新密码不可与当前相同 → 哈希落库。"""
        user = (
            await self.session.execute(select(User).where(User.id == user_id))
        ).scalar_one_or_none()
        if user is None:
            raise BusinessException(
                code=BusinessErrorCode.UNAUTHORIZED,
                message="账户不可用",
                status_code=401,
            )
        if not verify_password(current_password, user.password_hash):
            raise BusinessException(
                code=BusinessErrorCode.PASSWORD_WRONG,
                message="当前密码错误",
                status_code=400,
            )
        if new_password == current_password:
            raise BusinessException(
                code=BusinessErrorCode.VALIDATION_FAILED,
                message="新密码不能与当前密码相同",
                status_code=400,
            )
        user.password_hash = hash_password(new_password)
        await self.session.commit()
        await self.session.refresh(user)
        return user

    async def change_email(
        self, user_id: str, current_password: str, new_email: str
    ) -> User:
        """改邮箱：校验当前密码 → 新邮箱不可与当前相同 → 查重 → 落库。"""
        user = (
            await self.session.execute(select(User).where(User.id == user_id))
        ).scalar_one_or_none()
        if user is None:
            raise BusinessException(
                code=BusinessErrorCode.UNAUTHORIZED,
                message="账户不可用",
                status_code=401,
            )
        if not verify_password(current_password, user.password_hash):
            raise BusinessException(
                code=BusinessErrorCode.PASSWORD_WRONG,
                message="当前密码错误",
                status_code=400,
            )
        if new_email == user.email:
            raise BusinessException(
                code=BusinessErrorCode.VALIDATION_FAILED,
                message="新邮箱与当前邮箱相同",
                status_code=400,
            )
        occupied = (
            await self.session.execute(select(User).where(User.email == new_email))
        ).scalar_one_or_none()
        if occupied is not None:
            raise BusinessException(
                code=BusinessErrorCode.EMAIL_TAKEN,
                message="该邮箱已被注册",
                status_code=409,
            )
        user.email = new_email
        await self.session.commit()
        await self.session.refresh(user)
        return user

    async def delete_account(self, user_id: str) -> None:
        """注销：软删除（SET deletedAt = now），数据保留 30 天可恢复。"""
        user = (
            await self.session.execute(select(User).where(User.id == user_id))
        ).scalar_one_or_none()
        if user is None:
            raise BusinessException(
                code=BusinessErrorCode.UNAUTHORIZED,
                message="账户不可用",
                status_code=401,
            )
        user.deleted_at = datetime.now(timezone.utc)
        await self.session.commit()

    def _assert_restore_window(self, user: User) -> None:
        """已注销用户访问：未超期 → 1007（带剩余天数）；超期 → 1009。"""
        deadline = user.deleted_at + timedelta(days=ACCOUNT_RETENTION_DAYS)
        if datetime.now(timezone.utc) >= deadline:
            raise BusinessException(
                code=BusinessErrorCode.RESTORE_EXPIRED,
                message="注销冷静期已过，数据不可找回",
                status_code=410,
            )
        remaining = math.ceil((deadline - datetime.now(timezone.utc)).total_seconds() / 86400)
        raise AccountPendingDeletionException(max(remaining, 1))

    @staticmethod
    def issue_token(user: User) -> str:
        return create_access_token(user.id, user.email or "")
