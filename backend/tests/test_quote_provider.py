"""多提供方证券行情数据提供方 — admin CRUD（ADR-002 方案 X：无全局活跃源）。

依赖 require_admin（非管理员 → 403）。覆盖：
- CRUD：create（https / sdk 两种接入方式）、list、get、update、delete；
- config 校验：https 缺 base_url / sdk 缺 sdk_name → 422；
- 名称唯一性：重名（含大小写不敏感）→ 400，自改名（大小写不同）允许；
- 仅保留 enabled 开关（is_default / is_active 已在 ADR-002 移除）。

注意：测试库在会话内共享，故每个测试使用独立邮箱。
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

import app.db.database as dbmod
from app.core.enums import BusinessErrorCode, UserRole
from app.core.security import create_access_token
from app.models import User

from tests.helpers import auth, env, register_login

pytestmark = pytest.mark.asyncio

HTTPS_BODY = {
    "name": "AKShare",
    "access_method": "https",
    "config": {"base_url": "https://api.example.com"},
    "enabled": True,
}
SDK_BODY = {
    "name": "Tushare",
    "access_method": "sdk",
    "config": {"sdk_name": "tushare", "token": "x"},
    "enabled": True,
}


async def _admin_token(client, email: str) -> str:
    creds = await register_login(client, email=email, password="pw123456")
    async with dbmod.AsyncSessionLocal() as s:
        u = (await s.execute(select(User).where(User.id == creds["user_id"]))).scalar_one()
        u.role = UserRole.ADMIN.value
        await s.commit()
    return create_access_token(creds["user_id"], creds["email"], UserRole.ADMIN.value)


async def _user_token(client, email: str) -> str:
    creds = await register_login(client, email=email, password="pw123456")
    return create_access_token(creds["user_id"], creds["email"], UserRole.USER.value)


async def test_non_admin_forbidden(client):
    token = await _user_token(client, "qp_user_1@example.com")
    r = await client.get("/api/admin/quote-providers", headers=auth(token))
    status, code, _, _ = env(r)
    assert status == 403
    assert code == BusinessErrorCode.FORBIDDEN


async def test_create_and_list_https(client):
    token = await _admin_token(client, "qp_admin_1@example.com")
    r = await client.post("/api/admin/quote-providers", json=HTTPS_BODY, headers=auth(token))
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    pid = data["id"]
    assert data["access_method"] == "https"
    assert data["config"]["base_url"] == "https://api.example.com"
    # 列表：创建的提供方一定在其中（不依赖全局计数）
    r2 = await client.get("/api/admin/quote-providers", headers=auth(token))
    _, _, data2, _ = env(r2)
    assert isinstance(data2, list)
    assert any(p["id"] == pid for p in data2)


async def test_create_sdk(client):
    token = await _admin_token(client, "qp_admin_2@example.com")
    r = await client.post("/api/admin/quote-providers", json=SDK_BODY, headers=auth(token))
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["access_method"] == "sdk"
    assert data["config"]["sdk_name"] == "tushare"


async def test_create_requires_base_url_for_https(client):
    token = await _admin_token(client, "qp_admin_3@example.com")
    bad = dict(HTTPS_BODY, config={})  # 缺 base_url
    r = await client.post("/api/admin/quote-providers", json=bad, headers=auth(token))
    status, code, _, _ = env(r)
    assert status == 400
    assert code == BusinessErrorCode.VALIDATION_FAILED


async def test_create_requires_sdk_name_for_sdk(client):
    token = await _admin_token(client, "qp_admin_4@example.com")
    bad = dict(SDK_BODY, config={"token": "x"})  # 缺 sdk_name
    r = await client.post("/api/admin/quote-providers", json=bad, headers=auth(token))
    status, code, _, _ = env(r)
    assert status == 400
    assert code == BusinessErrorCode.VALIDATION_FAILED


async def test_get_and_update(client):
    token = await _admin_token(client, "qp_admin_5@example.com")
    r = await client.post("/api/admin/quote-providers", json=HTTPS_BODY, headers=auth(token))
    pid = env(r)[2]["id"]
    r = await client.get(f"/api/admin/quote-providers/{pid}", headers=auth(token))
    assert env(r)[0] == 200
    r = await client.patch(
        f"/api/admin/quote-providers/{pid}",
        json={"name": "AKShare 官方"},
        headers=auth(token),
    )
    status, code, data, _ = env(r)
    assert status == 200 and data["name"] == "AKShare 官方"


async def test_delete(client):
    token = await _admin_token(client, "qp_admin_6@example.com")
    r = await client.post("/api/admin/quote-providers", json=HTTPS_BODY, headers=auth(token))
    pid = env(r)[2]["id"]
    r = await client.delete(f"/api/admin/quote-providers/{pid}", headers=auth(token))
    assert env(r)[0] == 200
    r = await client.get(f"/api/admin/quote-providers/{pid}", headers=auth(token))
    assert env(r)[0] == 404


async def test_create_duplicate_name_returns_400(client):
    token = await _admin_token(client, "qp_admin_11@example.com")
    body = dict(HTTPS_BODY, name="DupSrc_11")
    r = await client.post("/api/admin/quote-providers", json=body, headers=auth(token))
    assert env(r)[0] == 200  # 首次创建成功
    # 完全相同名称 → 400
    r2 = await client.post("/api/admin/quote-providers", json=body, headers=auth(token))
    status, code, _, _ = env(r2)
    assert status == 400 and code == BusinessErrorCode.VALIDATION_FAILED
    # 大小写不敏感重名 → 400
    r3 = await client.post(
        "/api/admin/quote-providers",
        json=dict(HTTPS_BODY, name="dupsrc_11"),
        headers=auth(token),
    )
    status, code, _, _ = env(r3)
    assert status == 400 and code == BusinessErrorCode.VALIDATION_FAILED


async def test_update_to_existing_name_returns_400(client):
    token = await _admin_token(client, "qp_admin_12@example.com")
    ra = await client.post(
        "/api/admin/quote-providers", json=dict(HTTPS_BODY, name="DupA_12"), headers=auth(token)
    )
    id_a = env(ra)[2]["id"]
    rb = await client.post(
        "/api/admin/quote-providers", json=dict(SDK_BODY, name="DupB_12"), headers=auth(token)
    )
    id_b = env(rb)[2]["id"]
    # B 改名为 A（已存在）→ 400
    rp = await client.patch(
        f"/api/admin/quote-providers/{id_b}", json={"name": "DupA_12"}, headers=auth(token)
    )
    assert rp.status_code == 400
    # 同名自改名（大小写不同）应允许（排除自身）→ 200
    rp2 = await client.patch(
        f"/api/admin/quote-providers/{id_a}", json={"name": "dupsrc_12"}, headers=auth(token)
    )
    assert env(rp2)[0] == 200 and env(rp2)[2]["name"] == "dupsrc_12"


async def test_get_active_provider_removed_no_global_switch(client):
    """回归（ADR-002 方案 X）：提供方不再有全局 is_default / is_active 开关。

    create 时传入 is_default / is_active 应被忽略（pydantic 忽略额外字段），
    返回的提供方既不带 is_default 也不带 is_active 字段。
    """
    token = await _admin_token(client, "qp_admin_9@example.com")
    r = await client.post(
        "/api/admin/quote-providers",
        json={**HTTPS_BODY, "name": "A", "is_default": True, "is_active": True},
        headers=auth(token),
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert "is_default" not in data
    assert "is_active" not in data
    assert data["enabled"] is True
