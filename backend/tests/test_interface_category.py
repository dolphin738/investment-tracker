"""接口分类 CRUD + 删除不影响接口（SET NULL）— admin 集成测试。

依赖 require_admin（非管理员 → 403）。覆盖：
- CRUD：create / list（按 sort_order 升序）/ get / update / delete；
- 删除分类不影响接口：接口的 category_id 置 NULL（SET NULL），接口仍存活；
- 非管理员 → 403。

测试库在会话内共享，_clean_db 每个测试前 TRUNCATE 全部表（含迁移种子，故测试内自行创建数据）。
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

import app.db.database as dbmod
from app.core.enums import BusinessErrorCode, UserRole
from app.core.security import create_access_token
from app.models import InterfaceCategory, User
from app.services.market_data_sync import MASTER_LIST_CAT_ID, QUOTE_CAT_ID

from tests.helpers import auth, env, register_login

pytestmark = pytest.mark.asyncio

PROVIDER_BODY = {
    "name": "AKShare",
    "access_method": "https",
    "config": {"base_url": "https://api.example.com"},
    "enabled": True,
}

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


async def _create_provider(client, token: str) -> str:
    r = await client.post(
        "/api/admin/quote-providers", json=PROVIDER_BODY, headers=auth(token)
    )
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


async def _seed_system_categories() -> None:
    """按迁移种子重建 2 个固定系统分类（_clean_db 会 TRUNCATE，故测试内重建）。"""
    async with dbmod.AsyncSessionLocal() as s:
        for cid, label in ((MASTER_LIST_CAT_ID, "证券列表"), (QUOTE_CAT_ID, "证券行情")):
            if await s.get(InterfaceCategory, cid) is None:
                s.add(InterfaceCategory(id=cid, label=label, system=True))
        await s.commit()


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
        json={"label": "A股列表", "icon": "List", "sort_order": 2},
        headers=auth(token),
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    cid = data["id"]
    assert data["label"] == "A股列表"
    assert data["sort_order"] == 2

    r2 = await client.get("/api/admin/interface-categories", headers=auth(token))
    _, _, data2, _ = env(r2)
    assert isinstance(data2, list) and any(c["id"] == cid for c in data2)


async def test_get_update_delete(client):
    token = await _admin_token(client, "ic_admin_3@example.com")
    r = await client.post(
        "/api/admin/interface-categories",
        json={"label": "港股列表"},
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


async def test_delete_category_sets_interface_category_id_null(client):
    """删除分类不应删除接口：接口 category_id 置 NULL（SET NULL），接口仍存活。"""
    token = await _admin_token(client, "ic_admin_4@example.com")
    pid = await _create_provider(client, token)
    cid = await _create_category(client, token, label="A股列表")
    # 接口归属该分类
    r = await client.post(
        f"/api/admin/quote-providers/{pid}/interfaces",
        json={**INTERFACE_BASE, "category_id": cid},
        headers=auth(token),
    )
    iid = env(r)[2]["id"]

    # 删除分类
    r = await client.delete(
        f"/api/admin/interface-categories/{cid}", headers=auth(token)
    )
    assert env(r)[0] == 200
    # 接口仍然存活，category_id 被置 NULL（未分类）
    r = await client.get(
        f"/api/admin/quote-providers/interfaces/{iid}", headers=auth(token)
    )
    status, _, data, _ = env(r)
    assert status == 200
    assert data["category_id"] is None


async def test_system_category_cannot_be_deleted(client):
    """固定系统分类（证券列表 / 证券行情）不可删除，否则同步引擎按固定 UUID 选源会断链。"""
    token = await _admin_token(client, "ic_admin_5@example.com")
    await _seed_system_categories()

    for cid in (MASTER_LIST_CAT_ID, QUOTE_CAT_ID):
        r = await client.delete(
            f"/api/admin/interface-categories/{cid}", headers=auth(token)
        )
        status, _, _, msg = env(r)
        assert status == 400, (cid, status, msg)

    # 两个系统分类仍在列表中，且 system 标记为真
    r = await client.get("/api/admin/interface-categories", headers=auth(token))
    _, _, data, _ = env(r)
    sys_ids = {c["id"] for c in data if c.get("system")}
    assert {MASTER_LIST_CAT_ID, QUOTE_CAT_ID} <= sys_ids


async def test_create_category_with_system_label_rejected(client):
    """不可新建与系统分类同名的分类（分类即用途，避免出现两个「证券行情」歧义）。"""
    token = await _admin_token(client, "ic_admin_6@example.com")
    await _seed_system_categories()

    for label in ("证券列表", "证券行情"):
        r = await client.post(
            "/api/admin/interface-categories",
            json={"label": label},
            headers=auth(token),
        )
        status, _, _, msg = env(r)
        assert status == 400, (label, status, msg)

    # 非同名自定义分类不受影响
    cid = await _create_category(client, token, label="自定义分类")
    assert cid
