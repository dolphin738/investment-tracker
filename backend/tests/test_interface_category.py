"""接口分类 CRUD + 删除保护（分类下有接口不可删）— admin 集成测试。

依赖 require_admin（非管理员 → 403）。覆盖：
- CRUD：create / list（按 sort_order 升序）/ get / update / delete；
- 删除保护：分类下已配置接口时 DELETE → 400（接口归属不变）；空分类可删；
- 列表返回各分类下的接口数 interface_count；
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
    # 新建分类下无接口，interface_count 应为 0
    created = next(c for c in data2 if c["id"] == cid)
    assert created["interface_count"] == 0


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


async def test_delete_category_with_interfaces_rejected(client):
    """分类删除保护：分类下已配置接口时 DELETE → 400（接口归属不变）；空分类可删。"""
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

    # 列表返回该分类下已配置的接口数（前端据此禁用删除按钮）
    r = await client.get("/api/admin/interface-categories", headers=auth(token))
    _, _, data, _ = env(r)
    row = next(c for c in data if c["id"] == cid)
    assert row["interface_count"] == 1

    # 有接口的分类删除 → 400
    r = await client.delete(
        f"/api/admin/interface-categories/{cid}", headers=auth(token)
    )
    status, _, _, msg = env(r)
    assert status == 400, msg
    assert "1 个接口" in msg

    # 接口不受影响，category_id 保持不变
    r = await client.get(
        f"/api/admin/quote-providers/interfaces/{iid}", headers=auth(token)
    )
    status, _, data, _ = env(r)
    assert status == 200
    assert data["category_id"] == cid

    # 空分类删除 → 200 {"deleted": true}
    empty_cid = await _create_category(client, token, label="空分类")
    r = await client.delete(
        f"/api/admin/interface-categories/{empty_cid}", headers=auth(token)
    )
    status, _, data, _ = env(r)
    assert status == 200
    assert data["deleted"] is True


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


async def test_create_blank_label_rejected(client):
    """全空白 label 入库前应被 trim 后判空 → 400（防止空白占位数据）。"""
    token = await _admin_token(client, "ic_admin_7@example.com")
    r = await client.post(
        "/api/admin/interface-categories",
        json={"label": "   "},
        headers=auth(token),
    )
    status, _, _, msg = env(r)
    assert status == 400, msg
    assert "分类名不能为空" in msg


async def test_create_system_label_with_whitespace_rejected(client):
    """创建带首尾空格的系统同名分类，strip 后仍应触发同名 dup → 400。"""
    token = await _admin_token(client, "ic_admin_8@example.com")
    await _seed_system_categories()

    r = await client.post(
        "/api/admin/interface-categories",
        json={"label": "  证券列表  "},
        headers=auth(token),
    )
    status, _, _, msg = env(r)
    assert status == 400, msg
    assert "同名系统分类" in msg


async def test_delete_category_with_multiple_interfaces_rejected(client):
    """删除保护文案分支：同一分类下配置 2 个接口时 DELETE → 400，文案含「2 个接口」。"""
    token = await _admin_token(client, "ic_admin_9@example.com")
    pid = await _create_provider(client, token)
    cid = await _create_category(client, token, label="多接口分类")
    for idx in range(2):
        r = await client.post(
            f"/api/admin/quote-providers/{pid}/interfaces",
            json={**INTERFACE_BASE, "name": f"测试接口{idx}", "category_id": cid},
            headers=auth(token),
        )
        assert env(r)[0] == 200, env(r)[3]

    # 列表返回该分类下的接口计数应为 2
    r = await client.get("/api/admin/interface-categories", headers=auth(token))
    _, _, data, _ = env(r)
    row = next(c for c in data if c["id"] == cid)
    assert row["interface_count"] == 2

    r = await client.delete(
        f"/api/admin/interface-categories/{cid}", headers=auth(token)
    )
    status, _, _, msg = env(r)
    assert status == 400, msg
    assert "2 个接口" in msg
