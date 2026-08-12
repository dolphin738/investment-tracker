"""提供方接口 CRUD + 顶层 list_all + 级联删除 — admin 集成测试。

依赖 require_admin（非管理员 → 403）。覆盖：
- CRUD：create（归属某提供方）/ list_by_provider / get / update / delete；
- create 时提供方不存在 → 404；
- http_method 非法 → 422 → 归一 400 / VALIDATION_FAILED(2000)；
- 删除提供方级联删除其接口（复用现有 DELETE /api/admin/quote-providers/{id}）；
- list_all（GET /api/admin/quote-providers/interfaces）扁平返回全部接口；
- 非管理员 → 403。

测试库在会话内共享，_clean_db 每个测试前 TRUNCATE 全部表（含迁移种子，故测试内自行创建数据）。
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

PROVIDER_BODY = {
    "name": "AKShare",
    "access_method": "https",
    "config": {"base_url": "https://api.example.com"},
    "enabled": True,
}

# 接口基础字段（不含 category_id，由各测试先建分类后补 id）
INTERFACE_BASE = {
    "name": "沪深股票列表",
    "endpoint": "/api/ashare/list",
    "http_method": "GET",
    "params": {"code": "string"},
    "enabled": True,
    "description": "A股列表接口",
    "rate_limit": "100/min",
}


async def _admin_token(client, email: str) -> str:
    creds = await register_login(client, email=email, password="pw123456")
    async with dbmod.AsyncSessionLocal() as s:
        u = (
            await s.execute(select(User).where(User.id == creds["user_id"]))
        ).scalar_one()
        u.role = UserRole.ADMIN.value
        await s.commit()
    return create_access_token(creds["user_id"], creds["email"], UserRole.ADMIN.value)


async def _user_token(client, email: str) -> str:
    creds = await register_login(client, email=email, password="pw123456")
    return create_access_token(creds["user_id"], creds["email"], UserRole.USER.value)


async def _create_provider(client, token: str, name: str = "AKShare") -> str:
    body = dict(PROVIDER_BODY, name=name)
    r = await client.post("/api/admin/quote-providers", json=body, headers=auth(token))
    return env(r)[2]["id"]


async def _create_category(
    client, token: str, label: str = "A股列表", **overrides
) -> str:
    body = {"label": label, **overrides}
    r = await client.post(
        "/api/admin/interface-categories", json=body, headers=auth(token)
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0, data
    return data["id"]


async def test_non_admin_forbidden(client):
    token = await _user_token(client, "qi_user_1@example.com")
    r = await client.get("/api/admin/quote-providers/interfaces", headers=auth(token))
    status, code, _, _ = env(r)
    assert status == 403
    assert code == BusinessErrorCode.FORBIDDEN


async def test_create_and_list_by_provider(client):
    token = await _admin_token(client, "qi_admin_1@example.com")
    pid = await _create_provider(client, token)
    cid = await _create_category(client, token)
    r = await client.post(
        f"/api/admin/quote-providers/{pid}/interfaces",
        json={**INTERFACE_BASE, "category_id": cid},
        headers=auth(token),
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    iid = data["id"]
    assert data["provider_id"] == pid
    assert data["category_id"] == cid
    assert data["http_method"] == "GET"
    assert data["params"] == {"code": "string"}
    assert data["direction"] == "in"

    r2 = await client.get(
        f"/api/admin/quote-providers/{pid}/interfaces", headers=auth(token)
    )
    _, _, data2, _ = env(r2)
    assert isinstance(data2, list) and any(i["id"] == iid for i in data2)


async def test_create_requires_existing_provider(client):
    token = await _admin_token(client, "qi_admin_2@example.com")
    cid = await _create_category(client, token)
    r = await client.post(
        "/api/admin/quote-providers/00000000-0000-0000-0000-000000000000/interfaces",
        json={**INTERFACE_BASE, "category_id": cid},
        headers=auth(token),
    )
    status, code, _, _ = env(r)
    assert status == 404
    assert code == BusinessErrorCode.NOT_FOUND


async def test_create_invalid_http_method(client):
    token = await _admin_token(client, "qi_admin_3@example.com")
    pid = await _create_provider(client, token)
    cid = await _create_category(client, token)
    bad = dict(INTERFACE_BASE, category_id=cid, http_method="FOO")
    r = await client.post(
        f"/api/admin/quote-providers/{pid}/interfaces",
        json=bad,
        headers=auth(token),
    )
    status, code, _, _ = env(r)
    assert status == 400
    assert code == BusinessErrorCode.VALIDATION_FAILED


async def test_get_update_delete(client):
    token = await _admin_token(client, "qi_admin_4@example.com")
    pid = await _create_provider(client, token)
    cid = await _create_category(client, token)
    r = await client.post(
        f"/api/admin/quote-providers/{pid}/interfaces",
        json={**INTERFACE_BASE, "category_id": cid},
        headers=auth(token),
    )
    iid = env(r)[2]["id"]

    r = await client.get(
        f"/api/admin/quote-providers/interfaces/{iid}", headers=auth(token)
    )
    assert env(r)[0] == 200

    r = await client.patch(
        f"/api/admin/quote-providers/interfaces/{iid}",
        json={"name": "沪深股票列表（新版）", "enabled": False},
        headers=auth(token),
    )
    status, code, data, _ = env(r)
    assert status == 200 and data["name"] == "沪深股票列表（新版）"
    assert data["enabled"] is False

    r = await client.delete(
        f"/api/admin/quote-providers/interfaces/{iid}", headers=auth(token)
    )
    assert env(r)[0] == 200
    r = await client.get(
        f"/api/admin/quote-providers/interfaces/{iid}", headers=auth(token)
    )
    assert env(r)[0] == 404


async def test_get_not_found(client):
    token = await _admin_token(client, "qi_admin_5@example.com")
    r = await client.get(
        "/api/admin/quote-providers/interfaces/00000000-0000-0000-0000-000000000000",
        headers=auth(token),
    )
    status, code, _, _ = env(r)
    assert status == 404 and code == BusinessErrorCode.NOT_FOUND


async def test_provider_delete_cascades_interfaces(client):
    token = await _admin_token(client, "qi_admin_6@example.com")
    pid = await _create_provider(client, token)
    cid = await _create_category(client, token)
    r = await client.post(
        f"/api/admin/quote-providers/{pid}/interfaces",
        json={**INTERFACE_BASE, "category_id": cid},
        headers=auth(token),
    )
    iid = env(r)[2]["id"]
    # 删除提供方应级联删除其接口
    r = await client.delete(
        f"/api/admin/quote-providers/{pid}", headers=auth(token)
    )
    assert env(r)[0] == 200
    r = await client.get(
        f"/api/admin/quote-providers/interfaces/{iid}", headers=auth(token)
    )
    assert env(r)[0] == 404


async def test_list_all_returns_all_interfaces(client):
    token = await _admin_token(client, "qi_admin_7@example.com")
    pid1 = await _create_provider(client, token, name="A")
    pid2 = await _create_provider(client, token, name="B")
    cid1 = await _create_category(client, token, label="A股列表")
    cid2 = await _create_category(client, token, label="A股行情")
    await client.post(
        f"/api/admin/quote-providers/{pid1}/interfaces",
        json={**INTERFACE_BASE, "category_id": cid1},
        headers=auth(token),
    )
    await client.post(
        f"/api/admin/quote-providers/{pid2}/interfaces",
        json={**INTERFACE_BASE, "name": "A股日行情", "category_id": cid2},
        headers=auth(token),
    )
    r = await client.get("/api/admin/quote-providers/interfaces", headers=auth(token))
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert isinstance(data, list) and len(data) == 2
    # 扁平：含两个不同提供方的接口
    provider_ids = {i["provider_id"] for i in data}
    assert provider_ids == {pid1, pid2}
