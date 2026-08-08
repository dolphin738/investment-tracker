"""组合管理 API 集成测试 — 对齐 docs/ARCHITECTURE.md §4.2.2。

覆盖：创建 / 列表 / 详情 / 修改 / 删除 / 归属隔离（404 不泄露存在性）/
clear-data（清空子表保留组合）。
"""
from __future__ import annotations

import pytest

from tests.helpers import auth, env, register_login

pytestmark = pytest.mark.asyncio


async def test_create_and_list_portfolios(client):
    creds = await register_login(client, "pa@example.com", "pw123456")
    h = auth(creds["token"])
    r = await client.post(
        "/api/portfolios", headers=h, json={"name": "组合A", "currency": "CNY"}
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    pid = data["id"]
    assert data["name"] == "组合A"

    r = await client.get("/api/portfolios", headers=h)
    _, _, data, _ = env(r)
    ids = [p["id"] for p in data]
    assert pid in ids


async def test_get_and_patch_portfolio(client):
    creds = await register_login(client, "pb@example.com", "pw123456")
    h = auth(creds["token"])
    pid = (
        await client.post(
            "/api/portfolios", headers=h, json={"name": "原名称"}
        )
    ).json()["data"]["id"]

    r = await client.get(f"/api/portfolios/{pid}", headers=h)
    assert env(r)[0] == 200 and env(r)[1] == 0

    r = await client.patch(
        "/api/portfolios/{pid}".format(pid=pid), headers=h, json={"name": "新名称"}
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["name"] == "新名称"


async def test_portfolio_isolation_404(client):
    """用户 B 不能访问用户 A 的组合（统一 404，不泄露存在性）。"""
    a = await register_login(client, "iso-a@example.com", "pw123456")
    b = await register_login(client, "iso-b@example.com", "pw123456")
    pid = (
        await client.post(
            "/api/portfolios", headers=auth(a["token"]), json={"name": "A的组合"}
        )
    ).json()["data"]["id"]

    r = await client.get(f"/api/portfolios/{pid}", headers=auth(b["token"]))
    status, code, _, _ = env(r)
    assert status == 404 and code == 3001  # NOT_FOUND


async def test_delete_portfolio(client):
    creds = await register_login(client, "pd@example.com", "pw123456")
    h = auth(creds["token"])
    pid = (
        await client.post("/api/portfolios", headers=h, json={"name": "待删"})
    ).json()["data"]["id"]

    r = await client.delete(f"/api/portfolios/{pid}", headers=h)
    status, code, _, _ = env(r)
    assert status == 200 and code == 0

    r = await client.get(f"/api/portfolios/{pid}", headers=h)
    assert env(r)[0] == 404 and env(r)[1] == 3001


async def test_clear_data_keeps_portfolio(client):
    """DELETE /data 清空子表，但组合本身保留。"""
    creds = await register_login(client, "pc@example.com", "pw123456")
    h = auth(creds["token"])
    pid = (
        await client.post("/api/portfolios", headers=h, json={"name": "清数据组合"})
    ).json()["data"]["id"]
    # 造一条出入金，使子表非空
    await client.post(
        f"/api/portfolios/{pid}/cashflows",
        headers=h,
        json={"date": "2024-01-02", "type": "BUY", "amount": 1000},
    )
    r = await client.delete(f"/api/portfolios/{pid}/data", headers=h)
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    counts = data["deletedCount"]
    assert counts["cashflows"] >= 1

    # 组合仍在
    r = await client.get(f"/api/portfolios/{pid}", headers=h)
    assert env(r)[0] == 200
