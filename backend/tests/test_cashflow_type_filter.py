"""出入金列表类型筛选（types 参数）回归测试。

对应前端「出入金管理」页类型多选筛选器：点击「存入 / 取出」应只返回对应类型。
根因修复点：后端 list_cashflows 原未声明 types 参数、CashflowService.list_stmt
未做类型过滤，导致前端传参被忽略、永远返回全部。
"""
from __future__ import annotations

import pytest

from tests.helpers import auth, env, register_login

pytestmark = pytest.mark.asyncio


async def _seed_cashflow(client, h: dict, pid: str, cf_type: str, amount: str) -> None:
    st, code, _res, msg = env(
        await client.post(
            f"/api/portfolios/{pid}/cashflows",
            headers=h,
            json={"date": "2024-03-01", "type": cf_type, "amount": amount},
        )
    )
    assert st == 200 and code == 0, (st, code, msg)


async def _list_types(client, h: dict, pid: str, types: str | None):
    url = f"/api/portfolios/{pid}/cashflows"
    if types is not None:
        url += f"?types={types}"
    st, code, data, msg = env(await client.get(url, headers=h))
    assert st == 200 and code == 0, (st, code, msg)
    return data


async def test_cashflow_list_type_filter(client):
    u = await register_login(client)
    h = auth(u["token"])
    p = (await client.post("/api/portfolios", headers=h, json={"name": "P1"})).json()["data"]
    pid = p["id"]

    await _seed_cashflow(client, h, pid, "BUY", "100000.00")
    await _seed_cashflow(client, h, pid, "SELL", "20000.00")

    # 默认（无 types）= 全部 2 条
    all_ = await _list_types(client, h, pid, None)
    assert all_["total"] == 2

    # types=BUY 仅返回存入
    buy = await _list_types(client, h, pid, "BUY")
    assert buy["total"] == 1
    assert buy["items"][0]["type"] == "BUY"

    # types=SELL 仅返回取出
    sell = await _list_types(client, h, pid, "SELL")
    assert sell["total"] == 1
    assert sell["items"][0]["type"] == "SELL"

    # types=BUY,SELL = 全部
    both = await _list_types(client, h, pid, "BUY,SELL")
    assert both["total"] == 2


async def test_cashflow_list_type_filter_ignores_invalid(client):
    u = await register_login(client)
    h = auth(u["token"])
    p = (await client.post("/api/portfolios", headers=h, json={"name": "P1"})).json()["data"]
    pid = p["id"]

    await _seed_cashflow(client, h, pid, "BUY", "100000.00")

    # 非法类型值被忽略 → 返回全部（1 条），不应 400 也不应 0 条
    invalid = await _list_types(client, h, pid, "FOO")
    assert invalid["total"] == 1
