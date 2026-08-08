"""Phase 4.5 缺口补齐集成测试。

覆盖：
- auth §4.2.1 缺口：改密 / 改邮 / 注销
- portfolio §4.2.2 归档
- 计算 §4.2 历史序列：nav/history、xirr/history
- §4.2 单资源 GET：cashflows / securities / security-trades（含二级隔离 404）

全部为纯 Python FastAPI 增改，零 NestJS，不动 app/。
"""
from __future__ import annotations

import pytest

from tests.helpers import auth, env, register_login

pytestmark = pytest.mark.asyncio


# ───────────────────────── auth 改密 §4.2.1 ─────────────────────────
async def test_auth_change_password_success_and_relogin(client):
    u = await register_login(client, "cp@example.com", "oldpw12345")
    h = auth(u["token"])
    st, code, data, msg = env(
        await client.patch(
            "/api/auth/password",
            headers=h,
            json={"currentPassword": "oldpw12345", "newPassword": "newpw12345"},
        )
    )
    assert st == 200 and code == 0, (st, code, msg)
    assert data["accessToken"]

    # 新密码可登录
    r = await client.post(
        "/api/auth/login",
        json={"email": "cp@example.com", "password": "newpw12345"},
    )
    assert r.status_code == 200 and r.json()["code"] == 0
    # 旧密码不可登录
    r = await client.post(
        "/api/auth/login",
        json={"email": "cp@example.com", "password": "oldpw12345"},
    )
    assert r.json()["code"] != 0


async def test_auth_change_password_wrong_current(client):
    u = await register_login(client, "cpw@example.com", "pw12345678")
    h = auth(u["token"])
    st, code, _, msg = env(
        await client.patch(
            "/api/auth/password",
            headers=h,
            json={"currentPassword": "wrong", "newPassword": "newpw12345"},
        )
    )
    assert st == 400 and code == 1004, (st, code, msg)  # PASSWORD_WRONG


async def test_auth_change_password_same_as_current(client):
    u = await register_login(client, "cps@example.com", "pw12345678")
    h = auth(u["token"])
    st, code, _, msg = env(
        await client.patch(
            "/api/auth/password",
            headers=h,
            json={"currentPassword": "pw12345678", "newPassword": "pw12345678"},
        )
    )
    assert st == 400 and code == 2000, (st, code, msg)  # VALIDATION_FAILED


# ───────────────────────── auth 改邮 §4.2.1 ─────────────────────────
async def test_auth_change_email_success_and_relogin(client):
    await register_login(client, "taken@example.com", "pw12345678")  # 占住目标邮箱
    u = await register_login(client, "ce@example.com", "pw12345678")
    h = auth(u["token"])
    st, code, data, msg = env(
        await client.patch(
            "/api/auth/email",
            headers=h,
            json={"currentPassword": "pw12345678", "newEmail": "newce@example.com"},
        )
    )
    assert st == 200 and code == 0, (st, code, msg)
    assert data["user"]["email"] == "newce@example.com"
    r = await client.post(
        "/api/auth/login",
        json={"email": "newce@example.com", "password": "pw12345678"},
    )
    assert r.status_code == 200 and r.json()["code"] == 0


async def test_auth_change_email_taken(client):
    await register_login(client, "taken2@example.com", "pw12345678")
    u = await register_login(client, "ce2@example.com", "pw12345678")
    h = auth(u["token"])
    st, code, _, msg = env(
        await client.patch(
            "/api/auth/email",
            headers=h,
            json={"currentPassword": "pw12345678", "newEmail": "taken2@example.com"},
        )
    )
    assert st == 409 and code == 1003, (st, code, msg)  # EMAIL_TAKEN


async def test_auth_change_email_wrong_current(client):
    u = await register_login(client, "cew@example.com", "pw12345678")
    h = auth(u["token"])
    st, code, _, msg = env(
        await client.patch(
            "/api/auth/email",
            headers=h,
            json={"currentPassword": "wrong", "newEmail": "x@example.com"},
        )
    )
    assert st == 400 and code == 1004, (st, code, msg)


# ───────────────────────── auth 注销 §4.2.1 ─────────────────────────
async def test_auth_delete_account_and_cannot_login(client):
    u = await register_login(client, "del@example.com", "pw12345678")
    h = auth(u["token"])
    st, code, _, msg = env(await client.delete("/api/auth/account", headers=h))
    assert st == 200 and code == 0, (st, code, msg)
    r = await client.post(
        "/api/auth/login",
        json={"email": "del@example.com", "password": "pw12345678"},
    )
    assert r.json()["code"] != 0


# ───────────────────────── portfolio 归档 §4.2.2 ─────────────────────────
async def test_portfolio_archive_and_unarchive(client):
    u = await register_login(client)
    h = auth(u["token"])
    pid = (
        await client.post("/api/portfolios", headers=h, json={"name": "归档组合"})
    ).json()["data"]["id"]

    st, code, data, msg = env(
        await client.patch(
            f"/api/portfolios/{pid}/archive", headers=h, json={"archived": True}
        )
    )
    assert st == 200 and code == 0, (st, code, msg)
    assert data["archivedAt"] is not None

    st, code, data, _ = env(
        await client.patch(
            f"/api/portfolios/{pid}/archive", headers=h, json={"archived": False}
        )
    )
    assert data["archivedAt"] is None


# ───────────────────────── nav / xirr 历史 §4.2 计算 ─────────────────────────
async def _seed_calc_data(client, h, pid):
    await client.post(
        f"/api/portfolios/{pid}/cashflows",
        headers=h,
        json={"date": "2024-01-01", "type": "BUY", "amount": "100000"},
    )
    st, code, _, msg = env(
        await client.post(
            f"/api/portfolios/{pid}/snapshots",
            headers=h,
            json={
                "date": "2024-01-01",
                "totalAsset": "100000",
                "cashBalance": "100000",
            },
        )
    )
    assert st == 200 and code == 0, (st, code, msg)


async def test_nav_history_empty_then_with_data(client):
    u = await register_login(client)
    h = auth(u["token"])
    pid = (
        await client.post("/api/portfolios", headers=h, json={"name": "NAV历史"})
    ).json()["data"]["id"]
    st, code, data, _ = env(
        await client.get(f"/api/portfolios/{pid}/nav/history", headers=h)
    )
    assert st == 200 and code == 0 and data["total"] == 0

    await _seed_calc_data(client, h, pid)
    st, code, data, msg = env(
        await client.get(f"/api/portfolios/{pid}/nav/history", headers=h)
    )
    assert st == 200 and code == 0, (st, code, msg)
    assert data["total"] >= 1
    assert len(data["items"]) >= 1
    assert "cumulativeNav" in data["items"][0]
    assert "shares" in data["items"][0]


async def test_xirr_history_empty_then_with_data(client):
    u = await register_login(client)
    h = auth(u["token"])
    pid = (
        await client.post("/api/portfolios", headers=h, json={"name": "XIRR历史"})
    ).json()["data"]["id"]
    st, code, data, _ = env(
        await client.get(f"/api/portfolios/{pid}/xirr/history", headers=h)
    )
    assert st == 200 and code == 0 and data["total"] == 0

    await _seed_calc_data(client, h, pid)
    st, code, data, msg = env(
        await client.get(f"/api/portfolios/{pid}/xirr/history", headers=h)
    )
    assert st == 200 and code == 0, (st, code, msg)
    assert data["total"] >= 1
    assert len(data["items"]) >= 1
    assert "xirrValue" in data["items"][0]


# ───────────────────────── 单资源 GET §4.2 ─────────────────────────
async def _seed_security(client, h, pid, code="600000", name="浦发银行"):
    st, code_, data, msg = env(
        await client.post(
            f"/api/portfolios/{pid}/securities",
            headers=h,
            json={"code": code, "name": name, "type": "STOCK", "currency": "CNY"},
        )
    )
    assert st == 200 and code_ == 0, (st, code_, msg)
    return data["id"]


async def test_get_cashflow_by_id(client):
    u = await register_login(client)
    h = auth(u["token"])
    pid = (
        await client.post("/api/portfolios", headers=h, json={"name": "CF单查"})
    ).json()["data"]["id"]
    cf = (
        await client.post(
            f"/api/portfolios/{pid}/cashflows",
            headers=h,
            json={"date": "2024-02-01", "type": "BUY", "amount": "5000"},
        )
    ).json()["data"]
    cfid = cf["id"]

    st, code, data, _ = env(
        await client.get(f"/api/portfolios/{pid}/cashflows/{cfid}", headers=h)
    )
    assert st == 200 and code == 0
    assert data["id"] == cfid

    st, code, _, _ = env(
        await client.get(f"/api/portfolios/{pid}/cashflows/nonexistent", headers=h)
    )
    assert st == 404 and code == 3001


async def test_get_security_by_id(client):
    u = await register_login(client)
    h = auth(u["token"])
    pid = (
        await client.post("/api/portfolios", headers=h, json={"name": "SEC单查"})
    ).json()["data"]["id"]
    sid = await _seed_security(client, h, pid)
    st, code, data, _ = env(
        await client.get(f"/api/portfolios/{pid}/securities/{sid}", headers=h)
    )
    assert st == 200 and code == 0
    assert data["id"] == sid
    st, code, _, _ = env(
        await client.get(f"/api/portfolios/{pid}/securities/nonexistent", headers=h)
    )
    assert st == 404 and code == 3001


async def test_get_trade_by_id(client):
    u = await register_login(client)
    h = auth(u["token"])
    pid = (
        await client.post("/api/portfolios", headers=h, json={"name": "TRADE单查"})
    ).json()["data"]["id"]
    sid = await _seed_security(client, h, pid)
    # 现金基础 + 快照：重算要求成立日首笔为买入
    await client.post(
        f"/api/portfolios/{pid}/cashflows",
        headers=h,
        json={"date": "2024-03-01", "type": "BUY", "amount": "100000"},
    )
    st, code, _, msg = env(
        await client.post(
            f"/api/portfolios/{pid}/snapshots",
            headers=h,
            json={
                "date": "2024-03-01",
                "totalAsset": "100000",
                "cashBalance": "100000",
            },
        )
    )
    assert st == 200 and code == 0, (st, code, msg)
    tr = (
        await client.post(
            f"/api/portfolios/{pid}/security-trades",
            headers=h,
            json={
                "date": "2024-03-01",
                "securityId": sid,
                "side": "BUY_SEC",
                "quantity": "100",
                "price": "10",
            },
        )
    ).json()["data"]
    tid = tr["id"]
    st, code, data, _ = env(
        await client.get(f"/api/portfolios/{pid}/security-trades/{tid}", headers=h)
    )
    assert st == 200 and code == 0
    assert data["id"] == tid
    st, code, _, _ = env(
        await client.get(
            f"/api/portfolios/{pid}/security-trades/nonexistent", headers=h
        )
    )
    assert st == 404 and code == 3001
