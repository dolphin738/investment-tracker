"""数据 CRUD + 派生快照层 + 重算 集成测试 — 对齐 §4.2.3~§4.2.8 / §7.3 / §8 / §9.2。

完整链路：出入金 → 现金余额 → 标的 → 最新价 → 买入 → 触发派生快照(DERIVED) +
计算层(DailyNav/DailyXirr) → holdings/xirr/nav/recalculate 读端点。

另覆盖：§9.2 卖出硬校验、MANUAL 手工快照 + reset 回 DERIVED、删除标的级联重算。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from tests.helpers import auth, env, register_login

pytestmark = pytest.mark.asyncio

D1 = date(2024, 1, 2)   # 建仓日：入金 + 现金余额 + 首笔买入
D2 = date(2024, 1, 10)  # 后续：卖出 + 手工快照


async def _seed_portfolio_with_position(client, h, pid):
    """在组合内建好一个持仓：入金10万、现金余额9万、标的600000、现价10、买入1000股。"""
    await client.post(
        f"/api/portfolios/{pid}/cashflows",
        headers=h,
        json={"date": str(D1), "type": "BUY", "amount": 100000},
    )
    await client.post(
        f"/api/portfolios/{pid}/cash-balances",
        headers=h,
        json={"asOf": str(D1), "amount": 90000},
    )
    sec = (
        await client.post(
            f"/api/portfolios/{pid}/securities",
            headers=h,
            json={"code": "600000", "name": "平安银行", "type": "STOCK"},
        )
    ).json()["data"]
    sec_id = sec["id"]
    await client.post(
        f"/api/portfolios/{pid}/security-prices",
        headers=h,
        json={"securityId": sec_id, "price": 10, "asOf": str(D1)},
    )
    await client.post(
        f"/api/portfolios/{pid}/security-trades",
        headers=h,
        json={
            "date": str(D1),
            "securityId": sec_id,
            "side": "BUY_SEC",
            "quantity": 1000,
            "costPrice": 10,
        },
    )
    return sec_id


async def test_full_crud_triggers_derived_snapshot_and_calc(client):
    creds = await register_login(client, "crud@example.com", "pw123456")
    h = auth(creds["token"])
    pid = (
        await client.post("/api/portfolios", headers=h, json={"name": "持仓组合"})
    ).json()["data"]["id"]
    sec_id = await _seed_portfolio_with_position(client, h, pid)

    # ① 建仓日派生快照应为 DERIVED，total = 市值(1000*10) + 现金(90000) = 100000
    r = await client.get(f"/api/portfolios/{pid}/snapshots/{D1}", headers=h)
    status, code, snap, _ = env(r)
    assert status == 200 and code == 0
    assert snap["source"] == "DERIVED"
    assert Decimal(snap["totalAsset"]) == Decimal("100000")
    assert snap["valuationFlag"] == "EXACT"  # 有现金且有价 → EXACT

    # ② holdings：1000 股，市值 10000，pnl 0
    r = await client.get(
        f"/api/portfolios/{pid}/holdings", headers=h, params={"asOf": str(D1)}
    )
    _, _, holdings, _ = env(r)
    view = next(v for v in holdings if v["securityId"] == sec_id)
    assert Decimal(view["quantity"]) == Decimal(1000)
    assert Decimal(view["avgCost"]) == Decimal(10)
    assert Decimal(view["marketValue"]) == Decimal("10000")
    assert Decimal(view["pnl"]) == Decimal(0)
    assert view["isCostBased"] is False

    # ③ xirr/latest 与 nav/latest 均应产出数据
    r = await client.get(f"/api/portfolios/{pid}/xirr/latest", headers=h)
    _, _, xr, _ = env(r)
    assert xr is not None and xr["xirrValue"] is not None

    r = await client.get(f"/api/portfolios/{pid}/nav/latest", headers=h)
    _, _, nr, _ = env(r)
    assert nr is not None and nr["cumulativeNav"] is not None
    assert Decimal(nr["cumulativeNav"]) == Decimal("1.000000")  # 资产=份额=10万

    # ④ 写操作后存在 DailyNav / DailyXirr（经由 calc 路由读序列验证）
    r = await client.get(f"/api/portfolios/{pid}/nav", headers=h)
    _, _, series, _ = env(r)
    assert any(Decimal(str(p["value"])) > 0 for p in series)


async def test_sell_hard_check_rejects_oversell(client):
    """§9.2：卖出量超过当前持仓 → 400 (VALIDATION_FAILED 2000)。"""
    creds = await register_login(client, "sell@example.com", "pw123456")
    h = auth(creds["token"])
    pid = (
        await client.post("/api/portfolios", headers=h, json={"name": "卖出组合"})
    ).json()["data"]["id"]
    sec_id = await _seed_portfolio_with_position(client, h, pid)

    # 超卖 2000 > 持有 1000
    r = await client.post(
        f"/api/portfolios/{pid}/security-trades",
        headers=h,
        json={
            "date": str(D2),
            "securityId": sec_id,
            "side": "SELL_SEC",
            "quantity": 2000,
            "costPrice": 10,
        },
    )
    status, code, _, _ = env(r)
    assert status == 400 and code == 2000

    # 合法卖出 500 → 成功；持仓降为 500
    r = await client.post(
        f"/api/portfolios/{pid}/security-trades",
        headers=h,
        json={
            "date": str(D2),
            "securityId": sec_id,
            "side": "SELL_SEC",
            "quantity": 500,
            "costPrice": 10,
        },
    )
    assert env(r)[0] == 200

    r = await client.get(
        f"/api/portfolios/{pid}/holdings", headers=h, params={"asOf": str(D2)}
    )
    _, _, holdings, _ = env(r)
    view = next(v for v in holdings if v["securityId"] == sec_id)
    assert Decimal(view["quantity"]) == Decimal(500)


async def test_manual_snapshot_and_reset(client):
    """手工快照(MANUAL)覆盖派生值；reset 回 DERIVED。"""
    creds = await register_login(client, "manual@example.com", "pw123456")
    h = auth(creds["token"])
    pid = (
        await client.post("/api/portfolios", headers=h, json={"name": "手工组合"})
    ).json()["data"]["id"]
    sec_id = await _seed_portfolio_with_position(client, h, pid)
    # 先卖出 500，使 D2 派生值确定
    await client.post(
        f"/api/portfolios/{pid}/security-trades",
        headers=h,
        json={
            "date": str(D2),
            "securityId": sec_id,
            "side": "SELL_SEC",
            "quantity": 500,
            "costPrice": 10,
        },
    )

    # 手工覆盖 D2
    r = await client.post(
        f"/api/portfolios/{pid}/snapshots",
        headers=h,
        json={"date": str(D2), "totalAsset": 123456},
    )
    status, code, snap, _ = env(r)
    assert status == 200 and code == 0
    assert snap["source"] == "MANUAL"
    assert Decimal(snap["totalAsset"]) == Decimal(123456)
    # derivedTotalAsset 应为系统派生值：持仓500*10 + 现金90000 = 95000
    assert Decimal(snap["derivedTotalAsset"]) == Decimal(95000)

    # reset → DERIVED，值回退为 95000
    r = await client.post(
        f"/api/portfolios/{pid}/snapshots/{D2}/reset", headers=h
    )
    _, _, snap, _ = env(r)
    assert snap["source"] == "DERIVED"
    assert Decimal(snap["totalAsset"]) == Decimal(95000)


async def test_recalculate_range_returns_affected_dates(client):
    creds = await register_login(client, "recalc@example.com", "pw123456")
    h = auth(creds["token"])
    pid = (
        await client.post("/api/portfolios", headers=h, json={"name": "重算组合"})
    ).json()["data"]["id"]
    await _seed_portfolio_with_position(client, h, pid)

    r = await client.post(f"/api/portfolios/{pid}/recalculate", headers=h)
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["affectedDates"] >= 1  # 至少含建仓日快照

    r = await client.post(
        f"/api/portfolios/{pid}/recalculate-range",
        headers=h,
        json={"startDate": str(D1)},
    )
    _, _, data, _ = env(r)
    assert data["affectedDates"] >= 1


async def test_delete_security_cascades_and_recalc(client):
    """删除标的级联删 trades/prices，并触发受影响日 DERIVED 重建。"""
    creds = await register_login(client, "delsec@example.com", "pw123456")
    h = auth(creds["token"])
    pid = (
        await client.post("/api/portfolios", headers=h, json={"name": "级联组合"})
    ).json()["data"]["id"]
    sec_id = await _seed_portfolio_with_position(client, h, pid)

    r = await client.delete(f"/api/portfolios/{pid}/securities/{sec_id}", headers=h)
    assert env(r)[0] == 200

    # trades / prices 应被级联清空
    r = await client.get(
        f"/api/portfolios/{pid}/security-trades", headers=h
    )
    _, _, trades, _ = env(r)
    assert trades["total"] == 0
    r = await client.get(f"/api/portfolios/{pid}/security-prices", headers=h)
    _, _, prices, _ = env(r)
    assert prices["total"] == 0

    # D1 派生快照在删标的后市值归零（仅剩现金 90000）
    r = await client.get(f"/api/portfolios/{pid}/snapshots/{D1}", headers=h)
    _, _, snap, _ = env(r)
    assert snap["source"] == "DERIVED"
    assert Decimal(snap["totalAsset"]) == Decimal(90000)
