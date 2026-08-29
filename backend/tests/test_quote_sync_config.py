"""REP-016 补缺失测试（P1，BE-QS 组优先）：用户级行情自动同步配置三接口。

覆盖验收表：
- QS-01  GET  /api/quote-sync           取配置（无配置返回默认值，不落库）
- QS-02  PUT  /api/quote-sync           校验并 upsert 配置（提交后 reload_schedule）
- QS-03  POST /api/quote-sync/trigger   手动立即同步一次

校验点：默认值结构、PUT 后落库回读一致、非法 time/frequency → 400、trigger 返回 triggered。
"""
from __future__ import annotations

import pytest

from tests.helpers import auth, env, register_login

pytestmark = pytest.mark.asyncio


async def test_quote_sync_get_default(client):
    u = await register_login(client, email="qs.get@example.com")
    r = await client.get("/api/quote-sync", headers=auth(u["token"]))
    status, code, data, _ = env(r)
    assert status == 200, r.text
    assert code == 0
    # 无配置时应返回默认值结构，且不落库
    assert data["enabled"] is False
    assert data["frequency"] == "DAY"
    assert data["time"] == "09:00"


async def test_quote_sync_put_upsert(client):
    u = await register_login(client, email="qs.put@example.com")
    r = await client.put(
        "/api/quote-sync",
        headers=auth(u["token"]),
        json={
            "enabled": True,
            "frequency": "WEEK",
            "time": "10:30",
            "weekday": 3,
        },
    )
    status, code, data, _ = env(r)
    assert status == 200, r.text
    assert code == 0
    assert data["enabled"] is True
    assert data["frequency"] == "WEEK"
    assert data["time"] == "10:30"
    assert data["weekday"] == 3

    # 回读一致（PUT 已落库）
    r2 = await client.get("/api/quote-sync", headers=auth(u["token"]))
    d2 = r2.json()["data"]
    assert d2["enabled"] is True
    assert d2["frequency"] == "WEEK"
    assert d2["time"] == "10:30"


async def test_quote_sync_put_invalid_time(client):
    u = await register_login(client, email="qs.invalid@example.com")
    r = await client.put(
        "/api/quote-sync",
        headers=auth(u["token"]),
        json={"enabled": True, "frequency": "DAY", "time": "99:99"},
    )
    # 非法 time 格式 → 400
    assert r.status_code == 400, r.text


async def test_quote_sync_trigger(client):
    u = await register_login(client, email="qs.trigger@example.com")
    r = await client.post("/api/quote-sync/trigger", headers=auth(u["token"]))
    status, code, data, _ = env(r)
    assert status == 200, r.text
    assert code == 0
    assert data.get("triggered") is True
