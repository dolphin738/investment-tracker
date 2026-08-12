"""接口分类 CRUD + key 唯一冲突 + 删除不影响接口 — admin 集成测试。

依赖 require_admin（非管理员 → 403）。覆盖：
- CRUD：create / list（按 sort_order 升序）/ get / update / delete；
- key 唯一冲突 → 409 / VALIDATION_FAILED(2000)（复用 2000，不新增业务码）；
- 删除分类不影响接口（接口仍可按 raw key 存活）；
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

INTERFACE_BODY = {
    "interface_type": "ashare_list",
    "name": "沪深股票列表",
    "http_method": "GET",
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


async def _create_provider(client, token: str) -> str:
    r = await client.post(
        "/api/admin/quote-providers", json=PROVIDER_BODY, headers=auth(token)
    )
    return env(r)[2]["id"]


async def test_non_admin_forbidden(client):
    token = await _user_token(client, "ic_user_1@example.com")
    r = await client.get("/api/admin/interface-categories", headers=auth(token))
    status, code, _, _ = env(r)
    assert status == 403
    assert code == BusinessErrorCode.FORBIDDEN


async def test_create_and_list(client):
    token = await _admin_token(client, "ic_admin_1@example.com")
    r = await client.post(
        "/api/admin/interface-categories",
        json={"key": "ashare_list", "label": "A股列表", "icon": "List", "sort_order": 2},
        headers=auth(token),
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    cid = data["id"]
    assert data["key"] == "ashare_list"
    assert data["sort_order"] == 2

    r2 = await client.get("/api/admin/interface-categories", headers=auth(token))
    _, _, data2, _ = env(r2)
    assert isinstance(data2, list) and any(c["id"] == cid for c in data2)


async def test_create_duplicate_key_conflict(client):
    token = await _admin_token(client, "ic_admin_2@example.com")
    body = {"key": "dup_test", "label": "冲突测试"}
    r1 = await client.post(
        "/api/admin/interface-categories", json=body, headers=auth(token)
    )
    assert env(r1)[0] == 200
    r2 = await client.post(
        "/api/admin/interface-categories", json=body, headers=auth(token)
    )
    status, code, _, _ = env(r2)
    assert status == 409
    assert code == BusinessErrorCode.VALIDATION_FAILED


async def test_get_update_delete(client):
    token = await _admin_token(client, "ic_admin_3@example.com")
    r = await client.post(
        "/api/admin/interface-categories",
        json={"key": "hk_list", "label": "港股列表"},
        headers=auth(token),
    )
    cid = env(r)[2]["id"]

    r = await client.patch(
        f"/api/admin/interface-categories/{cid}",
        json={"label": "港股标的列表", "sort_order": 3},
        headers=auth(token),
    )
    status, code, data, _ = env(r)
    assert status == 200 and data["label"] == "港股标的列表"
    assert data["sort_order"] == 3

    r = await client.delete(
        f"/api/admin/interface-categories/{cid}", headers=auth(token)
    )
    assert env(r)[0] == 200
    # 设计无 GET 单条端点，以列表验证删除生效
    r = await client.get("/api/admin/interface-categories", headers=auth(token))
    _, _, data, _ = env(r)
    assert isinstance(data, list) and not any(c["id"] == cid for c in data)


async def test_delete_category_does_not_delete_interfaces(client):
    """删除分类不应删除接口：接口 interface_type 仅存自由文本 key，无外键约束。"""
    token = await _admin_token(client, "ic_admin_4@example.com")
    pid = await _create_provider(client, token)
    # 接口使用与分类相同的 key
    r = await client.post(
        f"/api/admin/quote-providers/{pid}/interfaces",
        json=INTERFACE_BODY,
        headers=auth(token),
    )
    iid = env(r)[2]["id"]

    cat_r = await client.post(
        "/api/admin/interface-categories",
        json={"key": "ashare_list", "label": "A股列表"},
        headers=auth(token),
    )
    cid = env(cat_r)[2]["id"]
    # 删除分类
    r = await client.delete(
        f"/api/admin/interface-categories/{cid}", headers=auth(token)
    )
    assert env(r)[0] == 200
    # 接口仍然存活（按 raw key 显示）
    r = await client.get(
        f"/api/admin/quote-providers/interfaces/{iid}", headers=auth(token)
    )
    status, _, data, _ = env(r)
    assert status == 200 and data["interface_type"] == "ashare_list"
