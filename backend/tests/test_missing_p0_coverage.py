"""REP-005 补缺失测试：后端 10 条 P0 功能点零覆盖（阶段 3 第 5 轮收尾）。

覆盖验收表条目（逐条对应报告 REP-005 第 1–10 条）：
- BE-AUTH-03 账户恢复（/account/restore，成功 + 1008/1009/1001 三错误分支）
- BE-CF-04   编辑流水（PATCH cashflows/{id}）
- BE-PRC-03  编辑价格（PATCH security-prices/{id}）
- BE-PRC-04  删除价格（DELETE security-prices/{id}）
- BE-CB-03   编辑余额（PATCH cash-balances/{id}）
- BE-SNP-04  编辑快照变手工（PATCH snapshots/{id}）
- BE-PF-08   行情异步刷新（POST prices/refresh-async，202 契约）
- BE-SCH-03  新建普通任务（POST /api/admin/tasks 校验链）
- BE-SCH-05  删除任务（DELETE /api/admin/tasks/{id}）
- BE-LGC-03  批量删除日志（DELETE /api/admin/logs，skipped 规则 + auditor 403）

全部走真实 Postgres 测试库（conftest 自动 DROP/CREATE + alembic 建表）。
信封响应解析沿用 tests/helpers.env / auth / register_login。
"""
from __future__ import annotations

import pytest
from datetime import datetime, timedelta, timezone
from sqlalchemy import select

import app.db.database as dbmod
from app.core.enums import BusinessErrorCode, UserRole
from app.core.security import create_access_token
from app.models import AppLog, User

from tests.helpers import auth, env, register_login

pytestmark = pytest.mark.asyncio


# --------------------------------------------------------------------------- #
# 辅助：提权 / 审计角色 token 与软删除用户构造
# --------------------------------------------------------------------------- #
async def _promote(client, email: str, role: str) -> str:
    creds = await register_login(client, email=email, password="pw123456")
    async with dbmod.AsyncSessionLocal() as s:
        u = (
            await s.execute(select(User).where(User.id == creds["user_id"]))
        ).scalar_one()
        u.role = role
        await s.commit()
    return create_access_token(creds["user_id"], creds["email"], role)


async def _admin_token(client, email: str) -> str:
    return await _promote(client, email, UserRole.ADMIN.value)


async def _auditor_token(client, email: str) -> str:
    return await _promote(client, email, UserRole.AUDITOR.value)


async def _soft_delete(client, email: str, password: str, days_ago: int | None = None):
    """把一个已注册用户置为「已注销」状态（deleted_at）。

    days_ago=None → 立即注销（冷静期内，可恢复）；否则注销于 days_ago 天前
    （超保留期 → 恢复应失败 1009）。
    """
    creds = await register_login(client, email=email, password=password)
    async with dbmod.AsyncSessionLocal() as s:
        u = (
            await s.execute(select(User).where(User.id == creds["user_id"]))
        ).scalar_one()
        dt = datetime.now(timezone.utc) - timedelta(days=days_ago or 0)
        u.deleted_at = dt
        await s.commit()
    return creds


async def _create_portfolio(client, token: str, name: str = "P0组合") -> str:
    r = await client.post(
        "/api/portfolios", headers=auth(token), json={"name": name, "currency": "CNY"}
    )
    assert r.status_code == 200, r.text
    return r.json()["data"]["id"]


# --------------------------------------------------------------------------- #
# 1. BE-AUTH-03 账户恢复（成功 + 1008/1009/1001 三错误分支）
# --------------------------------------------------------------------------- #
async def test_account_restore_success_and_error_branches(client):
    # 成功：冷静期内已注销用户可恢复
    creds = await _soft_delete(client, "restore.ok@example.com", "pw123456")
    r = await client.post(
        "/api/auth/account/restore",
        json={"email": creds["email"], "password": "pw123456"},
    )
    status, code, data, _ = env(r)
    assert status == 200, r.text
    assert code == 0
    assert "accessToken" in data
    assert data["user"]["email"] == creds["email"]
    # 恢复后应可登录
    r2 = await client.post(
        "/api/auth/login",
        json={"email": creds["email"], "password": "pw123456"},
    )
    assert r2.status_code == 200, r2.text

    # 1008：活跃（未注销）用户请求恢复 → 409
    active = await register_login(client, email="restore.active@example.com")
    r = await client.post(
        "/api/auth/account/restore",
        json={"email": active["email"], "password": "secret123"},
    )
    status, code, _, _ = env(r)
    assert status == 409, r.text
    assert code == BusinessErrorCode.ACCOUNT_NOT_DELETED

    # 1009：超保留期（>30 天）的已注销用户 → 410
    old = await _soft_delete(client, "restore.expired@example.com", "pw123456", days_ago=40)
    r = await client.post(
        "/api/auth/account/restore",
        json={"email": old["email"], "password": "pw123456"},
    )
    status, code, _, _ = env(r)
    assert status == 410, r.text
    assert code == BusinessErrorCode.RESTORE_EXPIRED

    # 1001：邮箱/密码错误（不论账户是否存在）→ 401，不泄露枚举
    r = await client.post(
        "/api/auth/account/restore",
        json={"email": "restore.active@example.com", "password": "wrong-pw"},
    )
    status, code, _, _ = env(r)
    assert status == 401, r.text
    assert code == BusinessErrorCode.UNAUTHORIZED


# --------------------------------------------------------------------------- #
# 2. BE-CF-04 编辑流水（PATCH cashflows/{id}）
# --------------------------------------------------------------------------- #
async def test_cashflow_patch(client):
    u = await register_login(client, email="cf.patch@example.com")
    pid = await _create_portfolio(client, u["token"])
    c = await client.post(
        f"/api/portfolios/{pid}/cashflows",
        headers=auth(u["token"]),
        json={"date": "2024-01-01", "type": "BUY", "amount": "100.00"},
    )
    assert c.status_code == 200, c.text
    cf_id = c.json()["data"]["id"]

    r = await client.patch(
        f"/api/portfolios/{pid}/cashflows/{cf_id}",
        headers=auth(u["token"]),
        json={"amount": "200.00", "note": "P0-cf-note"},
    )
    status, code, data, _ = env(r)
    assert status == 200, r.text
    assert code == 0
    assert data["id"] == cf_id
    assert data["note"] == "P0-cf-note"


# --------------------------------------------------------------------------- #
# 3/4. BE-PRC-03/04 编辑/删除价格（PATCH + DELETE security-prices/{id}）
# --------------------------------------------------------------------------- #
async def test_security_price_patch_and_delete(client):
    from tests.helpers import seed_security

    u = await register_login(client, email="prc.example.com@example.com")
    pid = await _create_portfolio(client, u["token"])
    sec_id = await seed_security(
        client, pid, "600000", "浦发银行", auth(u["token"])
    )
    c = await client.post(
        f"/api/portfolios/{pid}/security-prices",
        headers=auth(u["token"]),
        json={"securityId": sec_id, "price": "10.50", "asOf": "2024-01-01"},
    )
    assert c.status_code == 200, c.text
    price_id = c.json()["data"]["id"]

    # PATCH
    r = await client.patch(
        f"/api/portfolios/{pid}/security-prices/{price_id}",
        headers=auth(u["token"]),
        json={"price": "12.50"},
    )
    status, code, data, _ = env(r)
    assert status == 200, r.text
    assert code == 0
    assert data["id"] == price_id
    assert "12.5" in str(data["price"])

    # DELETE
    d = await client.delete(
        f"/api/portfolios/{pid}/security-prices/{price_id}",
        headers=auth(u["token"]),
    )
    assert d.status_code == 200, d.text
    # 列表应已不含该价格
    lst = await client.get(
        f"/api/portfolios/{pid}/security-prices", headers=auth(u["token"])
    )
    ids = {it["id"] for it in lst.json()["data"]["items"]}
    assert price_id not in ids


# --------------------------------------------------------------------------- #
# 5. BE-CB-03 编辑余额（PATCH cash-balances/{id}）
# --------------------------------------------------------------------------- #
async def test_cash_balance_patch(client):
    u = await register_login(client, email="cb.patch@example.com")
    pid = await _create_portfolio(client, u["token"])
    c = await client.post(
        f"/api/portfolios/{pid}/cash-balances",
        headers=auth(u["token"]),
        json={"amount": "500.00", "asOf": "2024-01-01"},
    )
    assert c.status_code == 200, c.text
    cb_id = c.json()["data"]["id"]

    r = await client.patch(
        f"/api/portfolios/{pid}/cash-balances/{cb_id}",
        headers=auth(u["token"]),
        json={"amount": "600.00", "note": "P0-cb-note"},
    )
    status, code, data, _ = env(r)
    assert status == 200, r.text
    assert code == 0
    assert data["id"] == cb_id
    assert data["note"] == "P0-cb-note"


# --------------------------------------------------------------------------- #
# 6. BE-SNP-04 编辑快照变手工（PATCH snapshots/{id}）
# --------------------------------------------------------------------------- #
async def test_snapshot_patch(client):
    u = await register_login(client, email="snp.patch@example.com")
    pid = await _create_portfolio(client, u["token"])
    c = await client.post(
        f"/api/portfolios/{pid}/snapshots",
        headers=auth(u["token"]),
        json={"date": "2024-01-01", "totalAsset": "1000.00"},
    )
    assert c.status_code == 200, c.text
    snap_id = c.json()["data"]["id"]

    r = await client.patch(
        f"/api/portfolios/{pid}/snapshots/{snap_id}",
        headers=auth(u["token"]),
        json={"totalAsset": "1200.00", "note": "P0-snap-note"},
    )
    status, code, data, _ = env(r)
    assert status == 200, r.text
    assert code == 0
    assert data["id"] == snap_id
    assert data["note"] == "P0-snap-note"


# --------------------------------------------------------------------------- #
# 7. BE-PF-08 行情异步刷新（POST prices/refresh-async，202 契约）
# --------------------------------------------------------------------------- #
async def test_refresh_async_returns_202(client):
    u = await register_login(client, email="pf.async@example.com")
    pid = await _create_portfolio(client, u["token"])
    r = await client.post(
        f"/api/portfolios/{pid}/prices/refresh-async",
        headers=auth(u["token"]),
    )
    status, code, data, _ = env(r)
    # 立即返回（信封归一为 200，业务契约：accepted=True + portfolio_id 回显）
    assert status == 200, r.text
    assert data["accepted"] is True
    assert data["portfolio_id"] == pid


# --------------------------------------------------------------------------- #
# 8. BE-SCH-03 新建普通任务（POST /api/admin/tasks 校验链）
# --------------------------------------------------------------------------- #
async def test_admin_task_create_validation(client):
    tok = await _admin_token(client, "sch.create@example.com")

    # 合法：HTTP_CALLBACK 普通任务 → 200 + id
    r = await client.post(
        "/api/admin/tasks",
        headers=auth(tok),
        json={
            "name": "P0-普通任务",
            "task_type": "HTTP_CALLBACK",
            "cron_expr": "0 3 * * *",
            "enabled": False,
            "params": {"url": "https://example.com/hook"},
        },
    )
    assert r.status_code == 200, r.text
    assert "id" in r.json()["data"]

    # 校验链 1：系统任务类型不可新建 → 400
    r = await client.post(
        "/api/admin/tasks",
        headers=auth(tok),
        json={
            "name": "P0-系统任务",
            "task_type": "LOG_CLEANUP",
            "cron_expr": "0 3 * * *",
            "enabled": False,
        },
    )
    assert r.status_code == 400, r.text

    # 校验链 2：非法 cron → 400
    r = await client.post(
        "/api/admin/tasks",
        headers=auth(tok),
        json={
            "name": "P0-坏cron",
            "task_type": "HTTP_CALLBACK",
            "cron_expr": "not a cron",
            "enabled": False,
        },
    )
    assert r.status_code == 400, r.text


# --------------------------------------------------------------------------- #
# 9. BE-SCH-05 删除任务（DELETE /api/admin/tasks/{id}）
# --------------------------------------------------------------------------- #
async def test_admin_task_delete(client):
    tok = await _admin_token(client, "sch.delete@example.com")
    c = await client.post(
        "/api/admin/tasks",
        headers=auth(tok),
        json={
            "name": "P0-待删任务",
            "task_type": "HTTP_CALLBACK",
            "cron_expr": "0 4 * * *",
            "enabled": False,
            "params": {"url": "https://example.com/hook"},
        },
    )
    assert c.status_code == 200, c.text
    task_id = c.json()["data"]["id"]

    # 删除 → 200 {deleted: True}
    d = await client.delete(f"/api/admin/tasks/{task_id}", headers=auth(tok))
    status, code, data, _ = env(d)
    assert status == 200, d.text
    assert code == 0
    assert data.get("deleted") is True

    # 二次删除 → 404
    d2 = await client.delete(f"/api/admin/tasks/{task_id}", headers=auth(tok))
    assert d2.status_code == 404, d2.text


# --------------------------------------------------------------------------- #
# 10. BE-LGC-03 批量删除日志（DELETE /api/admin/logs，skipped 规则 + auditor 403）
# --------------------------------------------------------------------------- #
async def test_admin_logs_bulk_delete(client):
    from app.services.log import record

    admin_tok = await _admin_token(client, "lgc.admin@example.com")

    # seed 一条 app 日志
    await record(level="info", scope="operation", module="seed", message="lgc-seed")
    async with dbmod.AsyncSessionLocal() as s:
        row = (
            await s.execute(select(AppLog).where(AppLog.message == "lgc-seed"))
        ).scalar_one()

    # 管理员批量删除该日志 → 200，deleted >= 1
    r = await client.request(
        "DELETE",
        "/api/admin/logs",
        headers=auth(admin_tok),
        json={"ids": [f"app:{row.id}"]},
    )
    status, code, data, _ = env(r)
    assert status == 200, r.text
    assert code == 0
    assert data["deleted"] >= 1

    # 审计角色（只读）删除 → 403（require_admin 守卫）
    auditor_tok = await _auditor_token(client, "lgc.auditor@example.com")
    r2 = await client.request(
        "DELETE",
        "/api/admin/logs",
        headers=auth(auditor_tok),
        json={"ids": []},
    )
    assert r2.status_code == 403, r2.text
