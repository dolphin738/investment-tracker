"""引导脚本：把指定邮箱的用户提升为管理员（role=admin）。

用法（在 backend/ 目录下）：
    BOOTSTRAP_ADMIN_EMAIL=you@example.com python -m scripts.bootstrap_admin

读环境变量 BOOTSTRAP_ADMIN_EMAIL，将该用户 role 置为 UserRole.ADMIN.value 并打印结果。
若未设置该环境变量、或用户不存在，打印提示并以非零码退出。
"""
from __future__ import annotations

import asyncio
import os
import sys

from sqlalchemy import select

from app.core.enums import UserRole
from app.db.database import AsyncSessionLocal
from app.models import User


async def main() -> int:
    email = os.environ.get("BOOTSTRAP_ADMIN_EMAIL")
    if not email:
        print("[bootstrap_admin] 未设置环境变量 BOOTSTRAP_ADMIN_EMAIL，已跳过。")
        return 1

    async with AsyncSessionLocal() as session:
        user = (
            await session.execute(select(User).where(User.email == email))
        ).scalar_one_or_none()
        if user is None:
            print(f"[bootstrap_admin] 用户不存在：{email}")
            return 2
        if user.role == UserRole.ADMIN.value:
            print(f"[bootstrap_admin] 用户已是管理员：{email}")
            return 0
        user.role = UserRole.ADMIN.value
        await session.commit()
        print(f"[bootstrap_admin] 已将 {email} 提升为管理员（role=admin）。")
        return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
