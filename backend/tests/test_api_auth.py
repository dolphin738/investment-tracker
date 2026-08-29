"""认证 API 集成测试 — 对齐 docs/ARCHITECTURE.md §4.2.1。

覆盖：注册 / 重复邮箱 / 登录 / 错误密码 / 受保护路由 / profile 修改 /
get_current_user 的 DB 校验（用户存在性 + 软删除判定 → 1001）。
"""
from __future__ import annotations

import pytest
from datetime import datetime, timezone

from sqlalchemy import select

import app.db.database as dbmod
from app.models import User

from tests.helpers import auth, env, register_login

pytestmark = pytest.mark.asyncio


async def test_register_success(client):
    r = await client.post(
        "/api/auth/register",
        json={"email": "u1@example.com", "password": "pw123456", "name": "U1"},
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["email"] == "u1@example.com"
    assert "id" in data and data["id"]


async def test_register_duplicate_email(client):
    await client.post(
        "/api/auth/register", json={"email": "dup@example.com", "password": "pw123456"}
    )
    r = await client.post(
        "/api/auth/register", json={"email": "dup@example.com", "password": "pw123456"}
    )
    status, code, _, _ = env(r)
    assert status == 409 and code == 1003  # EMAIL_TAKEN


async def test_login_wrong_password(client):
    await client.post(
        "/api/auth/register", json={"email": "l@example.com", "password": "right123"}
    )
    r = await client.post(
        "/api/auth/login", json={"email": "l@example.com", "password": "wrong123"}
    )
    status, code, _, _ = env(r)
    assert status == 401 and code == 1001  # 统一 1001，防枚举


async def test_login_success_returns_token(client):
    await client.post(
        "/api/auth/register",
        json={"email": "ok@example.com", "password": "pw123456"},
    )
    r = await client.post(
        "/api/auth/login", json={"email": "ok@example.com", "password": "pw123456"}
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["accessToken"]
    assert data["user"]["email"] == "ok@example.com"


async def test_me_requires_auth(client):
    r = await client.get("/api/auth/me")
    status, code, _, _ = env(r)
    assert status == 401 and code == 1001  # 缺失 token


async def test_me_with_token(client):
    creds = await register_login(client, "me@example.com", "pw123456")
    r = await client.get("/api/auth/me", headers=auth(creds["token"]))
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["email"] == "me@example.com"
    assert data["id"] == creds["user_id"]


async def test_profile_patch(client):
    creds = await register_login(client, "p@example.com", "pw123456")
    r = await client.patch(
        "/api/auth/profile", headers=auth(creds["token"]), json={"name": "NewName"}
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["name"] == "NewName"


async def test_soft_deleted_user_token_rejected(client):
    """get_current_user 接入 DB 校验：软删除账户持旧 token 访问 → 1001。"""
    creds = await register_login(client, "del@example.com", "pw123456")
    # 直接软删除（DB 层面），模拟注销冷静期内的账户
    async with dbmod.AsyncSessionLocal() as s:
        u = (
            await s.execute(select(User).where(User.id == creds["user_id"]))
        ).scalar_one()
        u.deleted_at = datetime.now(timezone.utc)
        await s.commit()
    r = await client.get("/api/auth/me", headers=auth(creds["token"]))
    status, code, _, _ = env(r)
    assert status == 401 and code == 1001  # 账户不可用
