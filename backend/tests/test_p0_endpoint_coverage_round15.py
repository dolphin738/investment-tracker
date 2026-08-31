"""REP-007 补缺失端点层覆盖（阶段 3 收口 · round 15）。

逐条对应验收表 P0 部分覆盖项（端点层契约）：
- BE-PF-07   实时行情同步端点：POST /api/portfolios/{id}/prices/sync
              + GET  /api/portfolios/{id}/prices/sync-status
- BE-ADM-13  管理面全量刷新编排端点：POST /api/admin/quote-providers/sync

两个 sync 端点都依赖 ``MarketDataSyncService.sync_portfolio_prices``（会真实打外部
行情接口），测试以 ``AsyncMock`` 替换该方法，仅验证端点层契约（鉴权 / 归属 /
信封 / 汇总结构），不触网。

走真实 Postgres 测试库（conftest 自动 DROP/CREATE + alembic 建表）。
"""
from __future__ import annotations

import pytest
from datetime import date, datetime, timezone
from unittest.mock import AsyncMock, patch

from sqlalchemy import select

import app.db.database as dbmod
from app.core.enums import UserRole
from app.models import SecurityPrice, User

from tests.helpers import auth, env, register_login

pytestmark = pytest.mark.asyncio


async def _create_portfolio(client, token: str, name: str = "P0组合") -> str:
    r = await client.post(
        "/api/portfolios", headers=auth(token), json={"name": name, "currency": "CNY"}
    )
    assert r.status_code == 200, r.text
    return r.json()["data"]["id"]


async def _admin_token(client, email: str) -> str:
    from app.core.security import create_access_token

    creds = await register_login(client, email=email)
    async with dbmod.AsyncSessionLocal() as s:
        u = (
            await s.execute(select(User).where(User.id == creds["user_id"]))
        ).scalar_one()
        u.role = UserRole.ADMIN.value
        await s.commit()
    return create_access_token(creds["user_id"], creds["email"], UserRole.ADMIN.value)


# --------------------------------------------------------------------------- #
# BE-PF-07 · POST /api/portfolios/{id}/prices/sync
# --------------------------------------------------------------------------- #
@patch(
    "app.services.market_data_sync.MarketDataSyncService.sync_portfolio_prices",
    new_callable=AsyncMock,
)
async def test_prices_sync_endpoint(mock_sync, client):
    u = await register_login(client, email="pf.sync@example.com")
    pid = await _create_portfolio(client, u["token"])
    mock_sync.return_value = {"synced": 2, "failed": 0, "skipped": 0, "errors": []}

    r = await client.post(
        f"/api/portfolios/{pid}/prices/sync", headers=auth(u["token"])
    )
    status, code, data, _ = env(r)
    assert status == 200, r.text
    assert code == 0
    assert data["synced"] == 2
    assert data["errors"] == []
    mock_sync.assert_awaited_once_with(pid)


async def test_prices_sync_endpoint_requires_auth(client):
    u = await register_login(client, email="pf.sync.auth@example.com")
    pid = await _create_portfolio(client, u["token"])
    r = await client.post(f"/api/portfolios/{pid}/prices/sync")  # 无鉴权头
    assert r.status_code == 401, r.text


async def test_prices_sync_endpoint_ownership_404(client):
    owner = await register_login(client, email="pf.sync.owner@example.com")
    pid = await _create_portfolio(client, owner["token"])
    other = await register_login(client, email="pf.sync.other@example.com")
    with patch(
        "app.services.market_data_sync.MarketDataSyncService.sync_portfolio_prices",
        new_callable=AsyncMock,
    ) as mock_sync:
        mock_sync.return_value = {"synced": 0, "failed": 0, "skipped": 0, "errors": []}
        r = await client.post(
            f"/api/portfolios/{pid}/prices/sync", headers=auth(other["token"])
        )
    assert r.status_code == 404, r.text


# --------------------------------------------------------------------------- #
# BE-PF-07 · GET /api/portfolios/{id}/prices/sync-status
# --------------------------------------------------------------------------- #
async def test_prices_sync_status_endpoint(client):
    from tests.helpers import seed_security

    u = await register_login(client, email="pf.status@example.com")
    pid = await _create_portfolio(client, u["token"])
    sec_id = await seed_security(
        client, pid, "600000", "浦发银行", auth(u["token"])
    )
    # 直接插入一条带 fetched_at / source 的价（模拟实时同步落库）
    async with dbmod.AsyncSessionLocal() as s:
        s.add(
            SecurityPrice(
                portfolio_id=pid,
                security_id=sec_id,
                price="10.50",
                as_of=date(2024, 1, 1),
                fetched_at=datetime.now(timezone.utc),
                source="小熊同学",
            )
        )
        await s.commit()

    r = await client.get(
        f"/api/portfolios/{pid}/prices/sync-status", headers=auth(u["token"])
    )
    status, code, data, _ = env(r)
    assert status == 200, r.text
    assert code == 0
    assert data["last_fetched_at"] is not None
    assert data["source"] == "小熊同学"


async def test_prices_sync_status_endpoint_empty(client):
    u = await register_login(client, email="pf.status.empty@example.com")
    pid = await _create_portfolio(client, u["token"])
    r = await client.get(
        f"/api/portfolios/{pid}/prices/sync-status", headers=auth(u["token"])
    )
    status, code, data, _ = env(r)
    assert status == 200, r.text
    assert code == 0
    assert data["last_fetched_at"] is None
    assert data["source"] is None


# --------------------------------------------------------------------------- #
# BE-ADM-13 · POST /api/admin/quote-providers/sync
# --------------------------------------------------------------------------- #
@patch(
    "app.services.market_data_sync.MarketDataSyncService.sync_portfolio_prices",
    new_callable=AsyncMock,
)
async def test_admin_sync_all_prices_endpoint(mock_sync, client):
    admin_tok = await _admin_token(client, "adm.sync@example.com")
    # 建一个普通用户 + 组合，使 portfolios >= 1
    u = await register_login(client, email="adm.sync.user@example.com")
    await _create_portfolio(client, u["token"])
    mock_sync.return_value = {"synced": 3, "failed": 0, "skipped": 0, "errors": []}

    r = await client.post(
        "/api/admin/quote-providers/sync", headers=auth(admin_tok)
    )
    status, code, data, _ = env(r)
    assert status == 200, r.text
    assert code == 0
    assert data["portfolios"] >= 1
    assert data["synced"] == 3
    assert data["failed"] == 0
    assert "errors" in data


async def test_admin_sync_all_prices_requires_admin(client):
    u = await register_login(client, email="adm.sync.forbidden@example.com")
    await _create_portfolio(client, u["token"])
    r = await client.post(
        "/api/admin/quote-providers/sync", headers=auth(u["token"])
    )
    assert r.status_code == 403, r.text


async def test_admin_sync_all_prices_requires_auth(client):
    r = await client.post("/api/admin/quote-providers/sync")
    assert r.status_code == 401, r.text
