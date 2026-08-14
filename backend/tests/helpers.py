"""Phase 3 集成测试辅助函数（被各 test_* 模块导入）。

提供：注册+登录拿 token、构造鉴权头、信封响应解析。
"""
from __future__ import annotations

from typing import Any

from httpx import AsyncClient


async def register_login(
    client: AsyncClient,
    email: str = "alice@example.com",
    password: str = "secret123",
    name: str = "Alice",
) -> dict[str, Any]:
    """注册并登录，返回 {token, user_id, email}。"""
    r = await client.post(
        "/api/auth/register",
        json={"email": email, "password": password, "name": name},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["code"] == 0, body
    uid = body["data"]["id"]
    r = await client.post(
        "/api/auth/login", json={"email": email, "password": password}
    )
    assert r.status_code == 200, r.text
    token = r.json()["data"]["accessToken"]
    return {"token": token, "user_id": uid, "email": email}


def auth(token: str) -> dict[str, str]:
    """Bearer 鉴权头。"""
    return {"Authorization": f"Bearer {token}"}


def env(resp) -> tuple[int, int, Any, Any]:
    """解析信封响应 → (http_status, code, data, message)。"""
    j = resp.json()
    return resp.status_code, j.get("code"), j.get("data"), j.get("message")


async def seed_security(
    client: AsyncClient,
    pid: str,
    code: str,
    name: str,
    h: dict[str, str],
    type: str | None = None,
    asset_class: Any | None = None,
    exchange: str | None = None,
) -> str:
    """ADR-003 拆表后建证券标的的标准路径：先建目录主数据 Security，再 resolve 出组合持仓。

    返回组合持仓（portfolio_securities）id，供 trade/price/dividend 的 securityId 使用。
    替代已移除的 POST /api/portfolios/{pid}/securities（D3 删除 Security.create）。
    """
    import app.db.database as dbmod
    from app.models import PortfolioSecurity, Security, SecurityType

    async with dbmod.AsyncSessionLocal() as s:
        master = Security(
            code=code,
            name=name,
            exchange=exchange,
            asset_class=asset_class or SecurityType.STOCK,
        )
        s.add(master)
        await s.commit()
        await s.refresh(master, ["id"])
        mid = master.id

    body = {"masterId": mid}
    if type is not None:
        body["type"] = type
    r = await client.post(
        f"/api/portfolios/{pid}/securities/resolve", headers=h, json=body
    )
    assert r.status_code == 200, r.text
    return r.json()["data"]["id"]
