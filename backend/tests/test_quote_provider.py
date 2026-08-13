"""多提供方证券行情数据提供方 — admin CRUD + 切换 + 互斥 + 解析链。

依赖 require_admin（非管理员 → 403）。覆盖：
- CRUD：create（https / sdk 两种接入方式）、list、get、update、delete；
- config 校验：https 缺 base_url / sdk 缺 sdk_name → 422；
- 互斥：is_default / is_active 全局至多一个（后者置位会清前者）；
- set_active 禁用的提供方 → 400；
- get_active_provider 回退链：当前 → 默认 → None；
- 非管理员访问 → 403。

注意：测试库在会话内共享，故每个测试使用独立邮箱，且基于「创建即清旧标记」的互斥语义做断言，
不依赖全局计数。
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

import app.db.database as dbmod
from app.core.enums import BusinessErrorCode, UserRole
from app.core.security import create_access_token
from app.models import User
from app.services.quote_provider import QuoteProviderService, get_active_provider

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


async def test_default_mutual_exclusion(client):
    token = await _admin_token(client, "qp_admin_7@example.com")
    r1 = await client.post(
        "/api/admin/quote-providers",
        json={**HTTPS_BODY, "name": "A", "is_default": True},
        headers=auth(token),
    )
    id_a = env(r1)[2]["id"]
    r2 = await client.post(
        "/api/admin/quote-providers",
        json={**SDK_BODY, "name": "B", "is_default": True},
        headers=auth(token),
    )
    id_b = env(r2)[2]["id"]
    ra = await client.get(f"/api/admin/quote-providers/{id_a}", headers=auth(token))
    rb = await client.get(f"/api/admin/quote-providers/{id_b}", headers=auth(token))
    assert env(ra)[2]["is_default"] is False
    assert env(rb)[2]["is_default"] is True


async def test_active_mutual_exclusion_and_disabled_blocked(client):
    token = await _admin_token(client, "qp_admin_8@example.com")
    r1 = await client.post(
        "/api/admin/quote-providers",
        json={**HTTPS_BODY, "name": "A", "is_active": True},
        headers=auth(token),
    )
    id_a = env(r1)[2]["id"]
    r2 = await client.post(
        "/api/admin/quote-providers",
        json={**SDK_BODY, "name": "B", "is_active": True},
        headers=auth(token),
    )
    id_b = env(r2)[2]["id"]
    ra = await client.get(f"/api/admin/quote-providers/{id_a}", headers=auth(token))
    rb = await client.get(f"/api/admin/quote-providers/{id_b}", headers=auth(token))
    assert env(ra)[2]["is_active"] is False
    assert env(rb)[2]["is_active"] is True
    # 创建禁用提供方 C，尝试设为当前 → 400
    r3 = await client.post(
        "/api/admin/quote-providers",
        json={**HTTPS_BODY, "name": "C", "enabled": False},
        headers=auth(token),
    )
    id_c = env(r3)[2]["id"]
    r = await client.post(f"/api/admin/quote-providers/{id_c}/set-active", headers=auth(token))
    assert r.status_code == 400
    rc = await client.get(f"/api/admin/quote-providers/{id_c}", headers=auth(token))
    assert env(rc)[2]["is_active"] is False


async def test_disabled_provider_cannot_be_default(client):
    token = await _admin_token(client, "qp_admin_10@example.com")
    r = await client.post(
        "/api/admin/quote-providers",
        json={**HTTPS_BODY, "name": "D", "enabled": False},
        headers=auth(token),
    )
    id_d = env(r)[2]["id"]
    # set-default 端点：禁用源 → 400
    rd = await client.post(
        f"/api/admin/quote-providers/{id_d}/set-default", headers=auth(token)
    )
    assert rd.status_code == 400
    # PATCH 显式 is_default=true：禁用源 → 400
    rp = await client.patch(
        f"/api/admin/quote-providers/{id_d}",
        json={"is_default": True},
        headers=auth(token),
    )
    assert rp.status_code == 400
    # 确认仍非默认
    rc = await client.get(f"/api/admin/quote-providers/{id_d}", headers=auth(token))
    assert env(rc)[2]["is_default"] is False


async def test_get_active_provider_fallback(client):
    token = await _admin_token(client, "qp_admin_9@example.com")
    # A 为默认（非当前），B 为当前；创建即清旧标记，状态确定
    r1 = await client.post(
        "/api/admin/quote-providers",
        json={**HTTPS_BODY, "name": "A", "is_default": True},
        headers=auth(token),
    )
    id_a = env(r1)[2]["id"]
    r2 = await client.post(
        "/api/admin/quote-providers",
        json={**SDK_BODY, "name": "B", "is_active": True},
        headers=auth(token),
    )
    id_b = env(r2)[2]["id"]

    async with dbmod.AsyncSessionLocal() as s:
        active = await get_active_provider(s)
        assert active is not None and active.id == id_b  # 当前优先
        # 取消 B 的当前标记 → 应回退到默认 A
        svc = QuoteProviderService(s)
        b = await svc.get(id_b)
        await svc.update(b, is_active=False)
        await s.commit()
        active2 = await get_active_provider(s)
        assert active2 is not None and active2.id == id_a  # 回退默认
