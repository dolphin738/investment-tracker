"""安全层测试 — require_admin / 角色实时判定（陈旧 JWT 不绕过）。

覆盖：
- role=user 访问受 require_admin 保护的端点 → 403 + 业务码 4001（FORBIDDEN）；
- role=admin → 通过（端点返回 404 表示 require_admin 已放行，key 不存在）；
- 改角色后旧 JWT 仍按 DB 实时判定：被降权的管理员持旧 admin token → 403；
- create_access_token 写入 role；get_current_user 从 DB 取 role（不信任 token）；
- require_admin 依赖直接调用：role=user 抛 403、role=admin 透传。
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

import app.db.database as dbmod
from app.core.enums import BusinessErrorCode, UserRole
from app.core.security import (
    CurrentUser,
    create_access_token,
    get_current_user,
    require_admin,
)
from app.models import User

from tests.helpers import auth, env, register_login

pytestmark = pytest.mark.asyncio


async def _set_role_and_token(client, email: str, role: str) -> str:
    """注册并登录后，将 DB 中该用户 role 置为给定值，返回该角色的新 token。"""
    creds = await register_login(client, email=email, password="pw123456")
    async with dbmod.AsyncSessionLocal() as s:
        u = (
            await s.execute(select(User).where(User.id == creds["user_id"]))
        ).scalar_one()
        u.role = role
        await s.commit()
    return create_access_token(creds["user_id"], email, role)


async def test_role_user_denied_403(client):
    token = await _set_role_and_token(client, "u_user@example.com", UserRole.USER.value)
    r = await client.get(
        "/api/admin/system-config/securities_quote_api_base_url", headers=auth(token)
    )
    status, code, _, _ = env(r)
    assert status == 403
    assert code == BusinessErrorCode.FORBIDDEN


async def test_role_admin_allowed(client):
    # admin 通过 require_admin 后，因该 key 尚未配置返回 404（说明鉴权已放行）
    token = await _set_role_and_token(client, "u_admin@example.com", UserRole.ADMIN.value)
    r = await client.get(
        "/api/admin/system-config/securities_quote_api_base_url", headers=auth(token)
    )
    status, _, _, _ = env(r)
    assert status == 404


async def test_stale_admin_token_rejected_after_demotion(client):
    """被降权的管理员持旧 admin token → 403（DB 实时判定，陈旧 JWT 不绕过）。"""
    email = "u_demote@example.com"
    admin_token = await _set_role_and_token(client, email, UserRole.ADMIN.value)
    # 降权为普通用户（模拟管理员被撤销）
    async with dbmod.AsyncSessionLocal() as s:
        u = (await s.execute(select(User).where(User.email == email))).scalar_one()
        u.role = UserRole.USER.value
        await s.commit()
    # 旧 admin token 仍尝试访问受保护端点 → 必须被拒
    r = await client.get(
        "/api/admin/system-config/securities_quote_api_base_url", headers=auth(admin_token)
    )
    status, code, _, _ = env(r)
    assert status == 403
    assert code == BusinessErrorCode.FORBIDDEN


async def test_create_access_token_carries_role():
    token = create_access_token("uid-1", "a@b.com", "admin")
    # 解码验证 payload 含 role
    from app.core.security import decode_access_token

    decoded = decode_access_token(token)
    assert decoded["role"] == "admin"
    assert decoded["sub"] == "uid-1"


async def test_get_current_user_reads_role_from_db(client):
    """get_current_user 以 DB role 为准（路由级端到端已覆盖，这里验证 DB 写入生效）。"""
    email = "u_dbrole@example.com"
    creds = await register_login(client, email=email, password="pw123456")
    async with dbmod.AsyncSessionLocal() as s:
        u = (await s.execute(select(User).where(User.id == creds["user_id"]))).scalar_one()
        u.role = UserRole.ADMIN.value
        await s.commit()
    # 用更新后的 role 重新登录，访问受保护端点应放行（证明 DB 实时 role 生效）
    r = await client.get(
        "/api/auth/me",
        headers=auth(
            create_access_token(creds["user_id"], email, UserRole.ADMIN.value)
        ),
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["role"] == UserRole.ADMIN.value


async def test_require_admin_dependency():
    """require_admin 作为依赖：user → 抛 403；admin → 透传。"""
    with pytest.raises(Exception) as exc_info_user:
        await require_admin(CurrentUser("u", "e", "user"))
    assert "权限" in str(exc_info_user.value)

    current = await require_admin(CurrentUser("u", "e", "admin"))
    assert current.role == "admin"
