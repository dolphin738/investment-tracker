"""D1：日期不为未来校验（对齐 app/ validateDateNotFuture）。

覆盖 cashflow / security-trade / security-price / cash-balance / snapshot 五个
写入口：未来日期应被拒绝（HTTP 400 / code 2000），历史/今日日期可正常写入。

仅基于代码行为（services/*.py 的 validate_date_not_future 调用）编写，不依赖文档。
"""
from __future__ import annotations

from datetime import timedelta

import pytest

from app.core.date_utils import today_app_tz

from tests.helpers import auth, env, register_login, seed_security

pytestmark = pytest.mark.asyncio

# 远未来，确定性触发拒绝（与服务器时区无关）
FUTURE = (today_app_tz() + timedelta(days=365)).isoformat()
PAST = "2024-01-02"


async def _new_portfolio(client):
    creds = await register_login(client, "d1@example.com", "pw123456")
    h = auth(creds["token"])
    pid = (
        await client.post("/api/portfolios", headers=h, json={"name": "D1组合"})
    ).json()["data"]["id"]
    return h, pid


async def test_cashflow_rejects_future_date(client):
    h, pid = await _new_portfolio(client)
    r = await client.post(
        f"/api/portfolios/{pid}/cashflows",
        headers=h,
        json={"date": FUTURE, "type": "BUY", "amount": 1000},
    )
    status, code, _, msg = env(r)
    assert status == 400 and code == 2000
    assert "未来" in (msg or "")


async def test_cashflow_accepts_past_date(client):
    h, pid = await _new_portfolio(client)
    r = await client.post(
        f"/api/portfolios/{pid}/cashflows",
        headers=h,
        json={"date": PAST, "type": "BUY", "amount": 1000},
    )
    assert env(r)[1] == 0  # code 0 = 成功


async def test_cashbalance_rejects_future_date(client):
    h, pid = await _new_portfolio(client)
    r = await client.post(
        f"/api/portfolios/{pid}/cash-balances",
        headers=h,
        json={"amount": 100, "asOf": FUTURE},
    )
    assert env(r)[0] == 400 and env(r)[1] == 2000


async def test_snapshot_rejects_future_date(client):
    h, pid = await _new_portfolio(client)
    r = await client.post(
        f"/api/portfolios/{pid}/snapshots",
        headers=h,
        json={"date": FUTURE, "totalAsset": 1000},
    )
    assert env(r)[0] == 400 and env(r)[1] == 2000


async def test_security_trade_rejects_future_date(client):
    h, pid = await _new_portfolio(client)
    sec = await seed_security(client, pid, "600000", "浦发银行", h)
    r = await client.post(
        f"/api/portfolios/{pid}/security-trades",
        headers=h,
        json={
            "date": FUTURE,
            "securityId": sec,
            "side": "BUY_SEC",
            "quantity": 100,
            "costPrice": "10",
        },
    )
    assert env(r)[0] == 400 and env(r)[1] == 2000


async def test_security_price_rejects_future_date(client):
    h, pid = await _new_portfolio(client)
    sec = await seed_security(client, pid, "600001", "招商银行", h)
    r = await client.post(
        f"/api/portfolios/{pid}/security-prices",
        headers=h,
        json={"securityId": sec, "price": 12, "asOf": FUTURE},
    )
    assert env(r)[0] == 400 and env(r)[1] == 2000
