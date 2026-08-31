"""定时任务执行日志端点的权限契约（BF-01 回归护栏）。

BF-01：`GET /api/admin/tasks/{id}/logs` 原先仅依赖 `get_current_user`，
**任意登录用户**即可读取任意任务的执行日志；而 `JobRunLogOut.message/error`
承载的是任务完整 stdout/stderr（LOCAL_COMMAND 类型下即命令输出），构成
越权信息泄露。修复后与其它 admin 端点一致收口为 `require_admin`
（基于数据库实时 role 校验，不信任 JWT payload 的 role）。

本文件固化两条断言，防止该端点权限被改回：
- 普通登录用户 → 403 FORBIDDEN
- 管理员 → 200

注意：测试库 `job_configs` 无种子数据（迁移虽写入过，但会话内为干净库），
故每个测试自建一个 HTTP_CALLBACK 任务再查其日志。刻意不使用 LOCAL_COMMAND，
使本护栏在 LOCAL_COMMAND 被移除后依然成立。
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

import app.db.database as dbmod
from app.core.enums import BusinessErrorCode, UserRole
from app.core.security import create_access_token
from app.models import User

from tests.helpers import auth, env, register_login

pytestmark = pytest.mark.asyncio


async def _admin_token(client, email: str) -> str:
    """注册用户 → 提权为 admin → 重新签发 token（role 变了必须重签）。"""
    creds = await register_login(client, email=email, password="pw123456")
    async with dbmod.AsyncSessionLocal() as s:
        u = (
            await s.execute(select(User).where(User.id == creds["user_id"]))
        ).scalar_one()
        u.role = UserRole.ADMIN.value
        await s.commit()
    return create_access_token(creds["user_id"], creds["email"], UserRole.ADMIN.value)


async def _user_token(client, email: str) -> str:
    creds = await register_login(client, email=email, password="pw123456")
    return create_access_token(creds["user_id"], creds["email"], UserRole.USER.value)


async def _create_task(client, admin_token: str, name: str) -> str:
    """管理员自建一个普通任务（HTTP_CALLBACK），返回其 id。"""
    r = await client.post(
        "/api/admin/tasks",
        headers=auth(admin_token),
        json={
            "name": name,
            "task_type": "HTTP_CALLBACK",
            "cron_expr": "0 3 * * *",
            "enabled": False,
            "params": {"url": "https://example.com/hook"},
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["data"]["id"]


async def test_task_logs_non_admin_forbidden(client):
    """普通登录用户读取任务执行日志 → 403 FORBIDDEN（BF-01 核心断言）。"""
    admin_tok = await _admin_token(client, "schedlog_admin_1@example.com")
    task_id = await _create_task(client, admin_tok, "BF01-日志权限-非管理员")

    user_tok = await _user_token(client, "schedlog_user_1@example.com")
    r = await client.get(f"/api/admin/tasks/{task_id}/logs", headers=auth(user_tok))
    status, code, _, _ = env(r)
    assert status == 403, r.text
    assert code == BusinessErrorCode.FORBIDDEN


async def test_task_logs_admin_ok(client):
    """管理员可正常读取任务执行日志（修复不应误伤管理员）。"""
    admin_tok = await _admin_token(client, "schedlog_admin_2@example.com")
    task_id = await _create_task(client, admin_tok, "BF01-日志权限-管理员")

    r = await client.get(f"/api/admin/tasks/{task_id}/logs", headers=auth(admin_tok))
    status, code, data, _ = env(r)
    assert status == 200, r.text
    assert code == 0
    # logs 端点走 paginate，data 为 {items, total, page, pageSize}
    assert "items" in data
