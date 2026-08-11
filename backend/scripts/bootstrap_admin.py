"""引导脚本：从环境变量读取邮箱，把指定用户创建/提升为管理员（role=admin）。

用法（在 backend/ 目录下）：
    # 方式 A：显式指定密码
    BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
    BOOTSTRAP_ADMIN_PASSWORD='替换为强密码' \
    [BOOTSTRAP_ADMIN_NAME='管理员'] \
    python -m scripts.bootstrap_admin

    # 方式 B：不提供密码 → 首次创建时自动生成随机强密码并打印/写入文件
    BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
    [BOOTSTRAP_ADMIN_NAME='管理员'] \
    [BOOTSTRAP_ADMIN_CREDENTIALS_FILE='/path/to/admin.cred'] \
    python -m scripts.bootstrap_admin

行为：
- 读取 BOOTSTRAP_ADMIN_EMAIL（必填）。
- 用户不存在：
  - 若提供 BOOTSTRAP_ADMIN_PASSWORD：用该密码创建管理员。
  - 若未提供：自动生成随机强密码（排除易混淆字符），创建管理员。
  - 自动建立默认用户偏好，与 UserService.register 口径一致。
  - 随机密码仅在「首次创建」时生成并打印/写入；建议在拿到后尽快登录修改。
- 用户已存在：若已是 admin 则跳过；否则仅把 role 提升为 admin（绝不改密码）。
- 幂等：可重复运行，不会产生重复账户、也不会重置已有密码。
- 展示随机密码：默认打印到 stdout；若设置 BOOTSTRAP_ADMIN_CREDENTIALS_FILE，
  则额外以 0600 权限写入该文件（如 Docker 挂卷取回）。
- 未设置 BOOTSTRAP_ADMIN_EMAIL 以非零码退出。
"""
from __future__ import annotations

import asyncio
import os
import secrets
import string
import sys

from sqlalchemy import select

from app.core.enums import UserRole
from app.core.security import hash_password
from app.db.database import AsyncSessionLocal
from app.models import User, UserPreference

# 用于生成随机密码的字符集（排除易混淆的 0/O/1/l/I）
_PASSWORD_ALPHABET = "".join(
    c for c in (string.ascii_letters + string.digits) if c not in "0O1lI"
)


def _generate_password(length: int = 16) -> str:
    """生成指定长度的随机强密码（密码学安全随机源）。"""
    return "".join(secrets.choice(_PASSWORD_ALPHABET) for _ in range(length))


def _write_credentials(path: str, email: str, password: str) -> None:
    """把凭据写入文件并设为 0600（仅文件所有者可读写）。"""
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(f"BOOTSTRAP_ADMIN_EMAIL={email}\n")
            f.write(f"BOOTSTRAP_ADMIN_PASSWORD={password}\n")
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass  # Windows 忽略 POSIX 权限，不影响写入
        print(f"[bootstrap_admin] 凭据已写入文件：{path}（权限 0600）")
    except OSError as e:
        print(f"[bootstrap_admin] 警告：写入凭据文件失败：{e}", file=sys.stderr)


async def main() -> int:
    email = (os.environ.get("BOOTSTRAP_ADMIN_EMAIL") or "").strip()
    if not email:
        print("[bootstrap_admin] 未设置环境变量 BOOTSTRAP_ADMIN_EMAIL，已跳过。")
        return 1

    password = os.environ.get("BOOTSTRAP_ADMIN_PASSWORD")
    name = (os.environ.get("BOOTSTRAP_ADMIN_NAME") or "").strip() or email.split("@")[0]
    cred_file = (os.environ.get("BOOTSTRAP_ADMIN_CREDENTIALS_FILE") or "").strip()

    async with AsyncSessionLocal() as session:
        user = (
            await session.execute(select(User).where(User.email == email))
        ).scalar_one_or_none()

        # 已存在 → 仅提升（绝不改密码，不重新生成随机密码）
        if user is not None:
            if user.role == UserRole.ADMIN.value:
                print(f"[bootstrap_admin] 用户已是管理员：{email}")
                return 0
            user.role = UserRole.ADMIN.value
            await session.commit()
            print(f"[bootstrap_admin] 已将 {email} 提升为管理员（role=admin）。")
            return 0

        # 不存在 → 首次创建为管理员
        generated = False
        if not password:
            password = _generate_password()
            generated = True

        user = User(
            email=email,
            password_hash=hash_password(password),
            name=name,
            role=UserRole.ADMIN.value,
        )
        session.add(user)
        await session.flush()
        # 与 UserService.register 口径一致：自动建立默认偏好
        session.add(UserPreference(user_id=user.id))
        await session.commit()
        await session.refresh(user)
        print(f"[bootstrap_admin] 已创建管理员账户：{email}（role=admin）。")
        if generated:
            # 先提交成功，再展示密码（避免提交失败时泄露/误导）
            print(
                f"[bootstrap_admin] ★ 首次创建已自动生成管理员密码：{password}\n"
                f"[bootstrap_admin]   请立即记录此密码，登录后建议尽快修改。"
            )
            if cred_file:
                _write_credentials(cred_file, email, password)
        return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
