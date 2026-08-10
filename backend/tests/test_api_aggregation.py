"""Phase 4 聚合端点集成测试 — 对齐 ARCHITECTURE §4.2.10/§4.2.14/§4.2.15/§4.2.16。

覆盖：summary / overview(含 freshness、navSeries、recentCashflows) / comparison /
drawdown / account/stats。数值字段经信封序列化为字符串，断言用 Decimal() 还原比较。
"""
from __future__ import annotations

import pytest
from datetime import timedelta
from decimal import Decimal

from app.core.date_utils import today_app_tz
from tests.helpers import auth, env, register_login

pytestmark = pytest.mark.asyncio

D1 = today_app_tz() - timedelta(days=5)
D2 = D1 + timedelta(days=1)


async def _seed(client, h, d1=D1):
    """播种一个完整组合：出资10万 → 买1000股@10 + 现金9万（总资10万）。"""
    cf = await client.post(
        "/api/portfolios", headers=h, json={"name": "P1", "currency": "CNY"}
    )
    pid = cf.json()["data"]["id"]
    await client.post(
        "/api/portfolios/{}/cashflows".format(pid),
        headers=h,
        json={"date": str(d1), "type": "BUY", "amount": 100000},
    )
    sec = await client.post(
        "/api/portfolios/{}/securities".format(pid),
        headers=h,
        json={"code": "A", "name": "StockA"},
    )
    sid = sec.json()["data"]["id"]
    await client.post(
        "/api/portfolios/{}/security-trades".format(pid),
        headers=h,
        json={
            "date": str(d1),
            "securityId": sid,
            "side": "BUY_SEC",
            "quantity": 1000,
            "costPrice": 10,
        },
    )
    await client.post(
        "/api/portfolios/{}/security-prices".format(pid),
        headers=h,
        json={"securityId": sid, "price": 10, "asOf": str(d1)},
    )
    await client.post(
        "/api/portfolios/{}/cash-balances".format(pid),
        headers=h,
        json={"amount": 90000, "asOf": str(d1)},
    )
    await client.post("/api/portfolios/{}/recalculate".format(pid), headers=h)
    return pid, sid


async def test_summary(client):
    u = await register_login(client)
    h = auth(u["token"])
    pid, _ = await _seed(client, h)

    st, code, data, msg = env(await client.get(f"/api/portfolios/{pid}/summary", headers=h))
    assert st == 200 and code == 0, (st, code, msg)
    for k in ("cumulativeXirr", "totalReturnRate", "yearReturnRate", "maxDrawdown", "latestDate", "inceptionDate"):
        assert k in data, k
    assert data["latestDate"] == str(today_app_tz())  # recalc 含 today 端点 → 最新快照为今天
    assert data["maxDrawdown"] is None  # P1 v1 恒 null
    assert Decimal(data["totalReturnRate"]) == Decimal("0.000000")  # 持平（10万→10万）


async def test_overview(client):
    u = await register_login(client)
    h = auth(u["token"])
    pid, _ = await _seed(client, h)

    st, code, data, msg = env(
        await client.get(f"/api/portfolios/{pid}/overview?range=all", headers=h)
    )
    assert st == 200 and code == 0, (st, code, msg)
    for k in ("totalAsset", "cumulativeXirr", "yearXirr", "navSeries", "recentCashflows", "freshness"):
        assert k in data, k
    assert Decimal(data["totalAsset"]) == Decimal("100000.00")
    assert len(data["navSeries"]) >= 1
    assert data["navSeries"][0]["date"] == str(D1)
    assert len(data["recentCashflows"]) >= 1
    assert data["recentCashflows"][0]["type"] == "BUY"
    assert Decimal(data["recentCashflows"][0]["amount"]) == Decimal("100000.00")
    # 缺陷1 回归：概览必须返回净投入（Σ存入−Σ取出），否则前端「净投入」卡显示「暂无数据」
    assert "netInvested" in data, "netInvested"
    assert Decimal(data["netInvested"]) == Decimal("100000.00")

    fr = data["freshness"]
    for k in ("staleDays", "isStale", "latestPriceAsOf", "latestCashAsOf", "reasons"):
        assert k in fr, k
    assert fr["latestPriceAsOf"] == str(D1)
    assert fr["latestCashAsOf"] == str(D1)
    assert fr["latestPriceLagDays"] == (today_app_tz() - D1).days
    assert isinstance(fr["isStale"], bool)
    assert isinstance(fr["reasons"], list)


async def test_comparison(client):
    u = await register_login(client)
    h = auth(u["token"])
    pid1, _ = await _seed(client, h)
    # 第二个空组合
    cf = await client.post(
        "/api/portfolios", headers=h, json={"name": "P2", "currency": "CNY"}
    )
    pid2 = cf.json()["data"]["id"]

    st, code, data, msg = env(await client.get("/api/portfolios/comparison", headers=h))
    assert st == 200 and code == 0, (st, code, msg)
    ids = {d["inceptionDate"] for d in data}  # 仅校验结构
    assert isinstance(data, list)
    assert len(data) == 2
    for item in data:
        for k in ("cumulativeXirr", "totalReturnRate", "yearReturnRate", "maxDrawdown", "latestDate", "inceptionDate"):
            assert k in item, k
    assert pid2  # 第二个组合已计入


async def test_drawdown(client):
    u = await register_login(client)
    h = auth(u["token"])
    pid, sid = await _seed(client, h, d1=D1)
    # D2：价格跌到 5 → 总资 5000+90000=95000，累计净值回落
    await client.post(
        "/api/portfolios/{}/security-prices".format(pid),
        headers=h,
        json={"securityId": sid, "price": 5, "asOf": str(D2)},
    )
    await client.post(
        "/api/portfolios/{}/cash-balances".format(pid),
        headers=h,
        json={"amount": 90000, "asOf": str(D2)},
    )
    await client.post("/api/portfolios/{}/recalculate".format(pid), headers=h)

    st, code, data, msg = env(
        await client.get(f"/api/portfolios/{pid}/metrics/drawdown", headers=h)
    )
    assert st == 200 and code == 0, (st, code, msg)
    # recalculateRange 含 today 作为区间端点，故至少 2 点（D1 峰 + D2 回落）
    assert len(data) >= 2, data
    # D1 为峰，回撤 0
    assert Decimal(data[0]["drawdown"]) == Decimal("0.000000")
    assert data[0]["peakDate"] == str(D1)
    # D2 回撤为负（资产 95000 < 峰 100000）
    d2 = next(p for p in data if p["date"] == str(D2))
    assert Decimal(d2["drawdown"]) < 0
    assert d2["peakDate"] == str(D1)


async def test_account_stats(client):
    u = await register_login(client)
    h = auth(u["token"])
    pid, _ = await _seed(client, h)

    st, code, data, msg = env(await client.get("/api/account/stats", headers=h))
    assert st == 200 and code == 0, (st, code, msg)
    # 缺陷6 新契约：AccountStatsOut（不再含 totalAssets/cumulativeXirr/yearXirr）
    for k in ("portfolioCount", "cashflowCount", "tradeCount", "snapshotDays", "recordDays", "firstDate", "lastDate"):
        assert k in data, k
    # _seed：1 组合 / 1 出入金 / 1 证券买卖 / recalculate 产生快照
    assert data["portfolioCount"] == 1
    assert data["cashflowCount"] == 1
    assert data["tradeCount"] == 1
    assert data["snapshotDays"] >= 1
    assert data["recordDays"] >= 1
    assert data["firstDate"] is not None
    assert data["lastDate"] is not None
