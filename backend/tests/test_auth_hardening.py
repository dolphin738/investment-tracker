"""REP-010：注册开关 / 登录限速 / 邮箱格式 / 密码最小长度 回归测试。

注意：get_settings 有 lru_cache，测试中改 env 后必须 get_settings.cache_clear()
才能让路由内的 get_settings() 重新读取。
"""
from __future__ import annotations

import pytest

from app.core.config import get_settings
from app.core.rate_limit import reset_all


@pytest.fixture(autouse=True)
def _reset():
    get_settings.cache_clear()
    reset_all()
    yield
    get_settings.cache_clear()
    reset_all()


@pytest.mark.asyncio
async def test_registration_disabled_returns_403(client, monkeypatch):
    monkeypatch.setenv("REGISTRATION_ENABLED", "false")
    get_settings.cache_clear()
    r = await client.post(
        "/api/auth/register",
        json={"email": "new@example.com", "password": "password123"},
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_register_invalid_email_422(client):
    r = await client.post(
        "/api/auth/register",
        json={"email": "not-an-email", "password": "password123"},
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_register_short_password_422(client):
    r = await client.post(
        "/api/auth/register",
        json={"email": "valid@example.com", "password": "short"},
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_login_rate_limit_429(client, monkeypatch):
    monkeypatch.setenv("LOGIN_RATE_LIMIT_PER_MINUTE", "3")
    monkeypatch.setenv("LOGIN_RATE_LIMIT_WINDOW_SECONDS", "60")
    get_settings.cache_clear()
    # 先建一个真实用户
    await client.post(
        "/api/auth/register",
        json={"email": "rl@example.com", "password": "password123"},
    )
    # 连续 4 次错误密码：前 3 次记录，第 4 次触发 429
    statuses = []
    for _ in range(4):
        r = await client.post(
            "/api/auth/login",
            json={"email": "rl@example.com", "password": "wrong"},
        )
        statuses.append(r.status_code)
    assert statuses[-1] == 429


@pytest.mark.asyncio
async def test_login_success_clears_failures(client, monkeypatch):
    monkeypatch.setenv("LOGIN_RATE_LIMIT_PER_MINUTE", "3")
    monkeypatch.setenv("LOGIN_RATE_LIMIT_WINDOW_SECONDS", "60")
    get_settings.cache_clear()
    await client.post(
        "/api/auth/register",
        json={"email": "ok@example.com", "password": "password123"},
    )
    # 2 次失败
    for _ in range(2):
        await client.post(
            "/api/auth/login",
            json={"email": "ok@example.com", "password": "wrong"},
        )
    # 正确密码登录成功 → 清空失败计数
    r = await client.post(
        "/api/auth/login",
        json={"email": "ok@example.com", "password": "password123"},
    )
    assert r.status_code == 200
    # 再次 3 次失败仍不应被限（计数已清空）
    for _ in range(3):
        r = await client.post(
            "/api/auth/login",
            json={"email": "ok@example.com", "password": "wrong"},
        )
    assert r.status_code != 429
