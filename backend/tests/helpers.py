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
