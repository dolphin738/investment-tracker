"""REP-011：JWT 吊销（token_version）回归测试。"""
from __future__ import annotations

import pytest

from app.core.security import create_access_token

from tests.helpers import auth, env, register_login

pytestmark = pytest.mark.asyncio


async def test_change_password_revokes_old_token(client):
    creds = await register_login(client, "rev@example.com", "password123")
    token_a = creds["token"]
    # 旧 token 可用
    assert env(await client.get("/api/auth/me", headers=auth(token_a)))[0] == 200

    # 改密码
    r = await client.patch(
        "/api/auth/password",
        json={"currentPassword": "password123", "newPassword": "newpassword456"},
        headers=auth(token_a),
    )
    assert env(r)[0] == 200

    # 旧 token 被吊销
    assert env(await client.get("/api/auth/me", headers=auth(token_a)))[0] == 403

    # 新密码登录得到的新 token 可用
    r = await client.post(
        "/api/auth/login",
        json={"email": "rev@example.com", "password": "newpassword456"},
    )
    token_b = env(r)[2]["accessToken"]
    assert env(await client.get("/api/auth/me", headers=auth(token_b)))[0] == 200


async def test_change_email_revokes_old_token(client):
    creds = await register_login(client, "mail@example.com", "password123")
    token_a = creds["token"]
    assert env(await client.get("/api/auth/me", headers=auth(token_a)))[0] == 200

    r = await client.patch(
        "/api/auth/email",
        json={"currentPassword": "password123", "newEmail": "mail2@example.com"},
        headers=auth(token_a),
    )
    assert env(r)[0] == 200
    # 旧 token 被吊销
    assert env(await client.get("/api/auth/me", headers=auth(token_a)))[0] == 403


async def test_legacy_token_without_tv_still_valid(client):
    """无 tv 声明的旧 token 对用户默认版本号(0)仍有效，不强制存量用户下线。"""
    creds = await register_login(client, "legacy@example.com", "password123")
    # 模拟迁移前签发的 token（不含 tv）
    legacy_token = create_access_token(creds["user_id"], creds["email"], "user")
    r = await client.get(
        "/api/auth/me", headers={"Authorization": f"Bearer {legacy_token}"}
    )
    assert env(r)[0] == 200
