"""日志中心聚合 API + 客户端上报 + 全局异常落库 —— 集成测试。

覆盖验收点：
- A. log_service.record 落库范围（5xx 落库 / 4xx 业务异常不落库）
- B. 聚合 API 角色守卫（list_logs / get_log）
- D. 客户端日志上报端点（client-log）
"""
from __future__ import annotations

import pytest
from datetime import datetime, timedelta, timezone
from sqlalchemy import func, select

import pytest_asyncio

import app.db.database as dbmod
from app.core.security import hash_password
from app.models.log import AppLog
from app.models.user import User
from app.services.log import record
from tests.helpers import auth, register_login

pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture(autouse=True)
async def _bind_test_sessionmaker(_engine):
    """conftest 在每个测试前把 dbmod.AsyncSessionLocal patch 成测试库引擎，但
    app.services.log / app.core.scheduler 在模块加载期就绑定了旧的 AsyncSessionLocal，
    导致 record() 与 _log_cleanup 实际落到开发库。这里把它们的模块级引用重绑到
    当前（测试库）maker，既让本模块测试可观测，也避免清理逻辑误删开发库数据。
    """
    import app.core.scheduler as scheduler_mod
    import app.services.log as log_mod

    log_mod.AsyncSessionLocal = dbmod.AsyncSessionLocal
    scheduler_mod.AsyncSessionLocal = dbmod.AsyncSessionLocal
    yield


# --------------------------------------------------------------------------- #
# 辅助：建一个指定角色的用户并拿 token
# --------------------------------------------------------------------------- #
async def _make_user(role: str, email: str) -> str:
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
    return email


async def _login(client, email: str) -> str:
    r = await client.post(
        "/api/auth/login", json={"email": email, "password": "secret123"}
    )
    assert r.status_code == 200, r.text
    return r.json()["data"]["accessToken"]


async def _count_app_logs() -> int:
    async with dbmod.AsyncSessionLocal() as s:
        return int((await s.execute(select(func.count()).select_from(AppLog))).scalar_one())


# --------------------------------------------------------------------------- #
# A. record 落库范围
# --------------------------------------------------------------------------- #
async def test_record_writes_app_log(client):
    """调 record(level='error', scope='server', ...) → app_logs 新增 1 行。"""
    before = await _count_app_logs()
    await record(
        level="error",
        scope="server",
        module="x",
        message="boom",
        trace="some trace",
    )
    after = await _count_app_logs()
    assert after - before == 1

    # 验证落库内容
    async with dbmod.AsyncSessionLocal() as s:
        row = (
            await s.execute(
                select(AppLog).where(AppLog.message == "boom")
            )
        ).scalar_one_or_none()
    assert row is not None
    assert row.level == "error"
    assert row.scope == "server"
    assert row.module == "x"
    assert row.trace == "some trace"


async def test_4xx_business_exception_does_not_land(client):
    """4xx 业务异常（错误密码登录 → 401 BusinessException）不触发 record 落库。"""
    # 先注册一个真实用户，保证登录接口会真正走到「校验失败→抛 BusinessException」
    await register_login(client, email="login4xx@example.com")
    before = await _count_app_logs()

    r = await client.post(
        "/api/auth/login",
        json={"email": "login4xx@example.com", "password": "wrong-password"},
    )
    # 业务异常返回 401/403 信封，不落库
    assert r.status_code in (401, 403)

    after = await _count_app_logs()
    # 差值断言：4xx 路径不应新增任何 app_logs
    assert after - before == 0


# --------------------------------------------------------------------------- #
# B. 聚合 API 角色守卫
# --------------------------------------------------------------------------- #
async def test_list_logs_forbidden_for_normal_user(client):
    """普通 user 调 GET /api/admin/logs → 403。"""
    u = await register_login(client, email="normal-user@example.com")
    r = await client.get("/api/admin/logs", headers=auth(u["token"]))
    assert r.status_code == 403


async def test_list_logs_ok_for_admin(client):
    """admin 调 GET /api/admin/logs → 200，返回 list + total 与 seed 条数一致。"""
    await _make_user("admin", "admin-l@example.com")
    token = await _login(client, "admin-l@example.com")

    # seed 几条 app_logs
    n = 3
    for i in range(n):
        await record(level="info", scope="operation", module="seed", message=f"seed-{i}")

    r = await client.get("/api/admin/logs", headers=auth(token))
    assert r.status_code == 200
    body = r.json()["data"]
    assert body["total"] >= n
    assert len(body["items"]) == min(body["pageSize"], body["total"])
    # 断言我们 seed 的条目都在列表中
    msgs = {it["message"] for it in body["items"]}
    assert {"seed-0", "seed-1", "seed-2"}.issubset(msgs)


async def test_get_log_app_prefix_and_404(client):
    """GET /api/admin/logs/{log_id}：app:/ 前缀取到行；不存在 → 404。"""
    await _make_user("auditor", "auditor-g@example.com")
    token = await _login(client, "auditor-g@example.com")

    await record(level="warning", scope="system", module="m", message="detail-msg")
    async with dbmod.AsyncSessionLocal() as s:
        row = (
            await s.execute(
                select(AppLog).where(AppLog.message == "detail-msg")
            )
        ).scalar_one()

    r = await client.get(f"/api/admin/logs/app:{row.id}", headers=auth(token))
    assert r.status_code == 200
    assert r.json()["data"]["id"] == f"app:{row.id}"
    assert r.json()["data"]["message"] == "detail-msg"

    r2 = await client.get("/api/admin/logs/app:00000000-0000-0000-0000-000000000000", headers=auth(token))
    assert r2.status_code == 404


async def test_list_logs_time_filter(client):
    """start/end（ISO 字符串）过滤生效：仅返回区间内的条目。

    验证 log_center 修复点：start/end 从 ISO 字符串解析为 datetime 后再绑定，
    created_at(timestamptz) 区间比较正确；修复前会因 `::timestamptz` 语法冲突或
    全 NULL 参数类型歧义导致 500。
    """
    await _make_user("admin", "admin-tf@example.com")
    token = await _login(client, "admin-tf@example.com")
    now = datetime.now(timezone.utc)

    # 先 INSERT 两条（created_at 走默认 now），再把 "old" 回拨到 10 天前，
    # 避开 CreatedAtMixin 的 default/server_default 对显式 created_at 的歧义。
    async with dbmod.AsyncSessionLocal() as s:
        s.add(AppLog(level="info", scope="operation", module="tf", message="recent"))
        s.add(AppLog(level="info", scope="operation", module="tf", message="old"))
        await s.commit()
    async with dbmod.AsyncSessionLocal() as s:
        await s.execute(
            select(AppLog).where(AppLog.message == "old").with_for_update()
        )
        old_row = (
            await s.execute(select(AppLog).where(AppLog.message == "old"))
        ).scalar_one()
        old_row.created_at = now - timedelta(days=10)
        await s.commit()

    start = (now - timedelta(days=5)).isoformat()
    # 用 params= 让 httpx 正确编码 ISO 中的 '+'（否则 '+' 在 query 中被解码为空格，
    # 导致 _parse_dt 解析失败、过滤被跳过）。真实前端 URLSearchParams/axios 同样会编码。
    r = await client.get("/api/admin/logs", params={"start": start}, headers=auth(token))
    assert r.status_code == 200, r.text
    msgs = {it["message"] for it in r.json()["data"]["items"]}
    # 10 天前的 "old" 应被过滤掉；"recent" 在区间内
    assert "recent" in msgs
    assert "old" not in msgs


# --------------------------------------------------------------------------- #
# D. 客户端日志上报端点
# --------------------------------------------------------------------------- #
async def test_client_log_authed_writes(client):
    """已登录 POST /api/client-logs 带合法 payload → 200 + {"ok":true}，新增 scope='client' 行。"""
    u = await register_login(client, email="client-u@example.com")
    before = await _count_app_logs()
    r = await client.post(
        "/api/client-logs",
        headers=auth(u["token"]),
        json={"level": "error", "module": "frontend", "message": "client-boom",
              "trace": "stack"},
    )
    assert r.status_code == 200
    assert r.json()["data"] == {"ok": True}

    after = await _count_app_logs()
    assert after - before == 1
    async with dbmod.AsyncSessionLocal() as s:
        row = (
            await s.execute(
                select(AppLog).where(AppLog.message == "client-boom")
            )
        ).scalar_one_or_none()
    assert row is not None
    assert row.scope == "client"
    assert row.module == "frontend"


async def test_client_log_anonymous_rejected(client):
    """未登录（无 token）→ 401/403，不写库。"""
    before = await _count_app_logs()
    r = await client.post(
        "/api/client-logs",
        json={"level": "error", "module": "frontend", "message": "anon-boom"},
    )
    assert r.status_code in (401, 403)
    # 匿名请求即使 payload 非法也不应落库
    after = await _count_app_logs()
    assert after - before == 0
