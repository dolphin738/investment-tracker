"""GET /api/admin/securities/masters/stats 权限护栏。

2026-09-17 收紧：该端点原为「任意登录用户可读」（Depends(get_current_user)），
现收口为「仅管理员可读」（Depends(require_admin)），与 StockListPanel 管理页
（use-security-master.ts 仅 admin 消费）配套。

覆盖：
- 普通登录用户（role=user）→ 403 FORBIDDEN（require_admin 以 DB 实时 role 为准）
- 管理员（role=admin）→ 200 + {counts: {...}}
"""
from __future__ import annotations

import pytest

import app.db.database as dbmod
from app.core.security import hash_password
from app.models.user import User
from tests.helpers import auth, env

pytestmark = pytest.mark.asyncio


async def _make_user(role: str, email: str) -> None:
    async with dbmod.AsyncSessionLocal() as s:
        s.add(
            User(
                email=email,
                password_hash=hash_password("secret123"),
                name=email.split("@")[0],
                role=role,
            )
        )
        await s.commit()


async def _login(client, email: str) -> str:
    r = await client.post(
        "/api/auth/login", json={"email": email, "password": "secret123"}
    )
    assert r.status_code == 200, r.text
    return r.json()["data"]["accessToken"]


async def test_stats_forbids_non_admin(client):
    """普通登录用户访问 /stats → 403（require_admin 守卫）。"""
    await _make_user("user", "stats_nonadmin@example.com")
    token = await _login(client, "stats_nonadmin@example.com")
    r = await client.get(
        "/api/admin/securities/masters/stats", headers=auth(token)
    )
    status, code, _, _ = env(r)
    assert status == 403, r.text


async def test_stats_allows_admin(client):
    """管理员访问 /stats → 200 + counts 字典。"""
    await _make_user("admin", "stats_admin@example.com")
    token = await _login(client, "stats_admin@example.com")
    r = await client.get(
        "/api/admin/securities/masters/stats", headers=auth(token)
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0, r.text
    assert "counts" in data
