"""系统配置（admin）集成测试。

覆盖：
- admin 可 PATCH / GET securities_quote_api_base_url；
- 非 admin 写入 → 403（FORBIDDEN）；
- 非白名单 key → PATCH 400 / GET 404（避免任意键写入 / 探测）；
- get_quote_api_base_url 在无 DB 行时回退 env（settings.SECURITIES_QUOTE_API_BASE_URL）。
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

import app.db.database as dbmod
from app.core.config import get_settings
from app.core.enums import BusinessErrorCode, UserRole
from app.core.security import create_access_token
from app.models import User
from app.services.system_config import get_quote_api_base_url

from tests.helpers import auth, env, register_login

pytestmark = pytest.mark.asyncio


async def _admin_token(client, email: str) -> str:
    creds = await register_login(client, email=email, password="pw123456")
    async with dbmod.AsyncSessionLocal() as s:
        u = (
            await s.execute(select(User).where(User.id == creds["user_id"]))
        ).scalar_one()
        u.role = UserRole.ADMIN.value
        await s.commit()
    return create_access_token(creds["user_id"], email, UserRole.ADMIN.value)


async def test_admin_write_and_read(client):
    token = await _admin_token(client, "cfg_admin@example.com")
    # 写入
    r = await client.patch(
        "/api/admin/system-config/securities_quote_api_base_url",
        headers=auth(token),
        json={"url": "https://quote.example.com/v1"},
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["key"] == "securities_quote_api_base_url"
    assert data["value"]["url"] == "https://quote.example.com/v1"

    # 读取
    r = await client.get(
        "/api/admin/system-config/securities_quote_api_base_url", headers=auth(token)
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["value"]["url"] == "https://quote.example.com/v1"


async def test_admin_upsert_overwrites(client):
    token = await _admin_token(client, "cfg_upsert@example.com")
    await client.patch(
        "/api/admin/system-config/securities_quote_api_base_url",
        headers=auth(token),
        json={"url": "https://first.example.com"},
    )
    r = await client.patch(
        "/api/admin/system-config/securities_quote_api_base_url",
        headers=auth(token),
        json={"url": "https://second.example.com"},
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["value"]["url"] == "https://second.example.com"


async def test_non_admin_write_forbidden(client):
    creds = await register_login(client, "cfg_user@example.com", "pw123456")
    r = await client.patch(
        "/api/admin/system-config/securities_quote_api_base_url",
        headers=auth(creds["token"]),
        json={"url": "https://evil.example.com"},
    )
    status, code, _, _ = env(r)
    assert status == 403
    assert code == BusinessErrorCode.FORBIDDEN


async def test_non_whitelist_key_rejected(client):
    token = await _admin_token(client, "cfg_wl@example.com")
    # PATCH 非白名单 key → 400
    r = await client.patch(
        "/api/admin/system-config/secret_key",
        headers=auth(token),
        json={"foo": "bar"},
    )
    status, _, _, _ = env(r)
    assert status == 400
    # GET 非白名单 key → 404
    r = await client.get("/api/admin/system-config/secret_key", headers=auth(token))
    status, _, _, _ = env(r)
    assert status == 404


async def test_get_quote_api_base_url_fallback_env(client, monkeypatch):
    """无 DB 行时回退 settings.SECURITIES_QUOTE_API_BASE_URL（env）。"""
    settings = get_settings()
    monkeypatch.setattr(
        settings, "SECURITIES_QUOTE_API_BASE_URL", "https://env.example.com/api"
    )
    async with dbmod.AsyncSessionLocal() as db:
        url = await get_quote_api_base_url(db)
    assert url == "https://env.example.com/api"


async def test_get_quote_api_base_url_db_wins(client, monkeypatch):
    """DB 有行时优先用 DB，不回退 env。"""
    settings = get_settings()
    monkeypatch.setattr(
        settings, "SECURITIES_QUOTE_API_BASE_URL", "https://env.example.com/api"
    )
    token = await _admin_token(client, "cfg_dbwins@example.com")
    await client.patch(
        "/api/admin/system-config/securities_quote_api_base_url",
        headers=auth(token),
        json={"url": "https://db.example.com"},
    )
    async with dbmod.AsyncSessionLocal() as db:
        url = await get_quote_api_base_url(db)
    assert url == "https://db.example.com"
