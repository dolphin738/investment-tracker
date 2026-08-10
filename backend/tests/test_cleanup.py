"""P0 定时清理测试（方案 c：内部 cron 端点 + 账户物理清理 + 头像孤儿清理）。

覆盖：
- physical_purge：超期软删用户被删、未超期保留（核心不变量）；
- sweep_orphan_avatars：未被 user.avatar 引用的头像被删、被引用的保留（安全闸门）；
- 内部端点保护：缺令牌 / 错令牌 → 403；正确令牌 → 200 且实际触发清理。
"""
from __future__ import annotations

import pytest
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

import app.db.database as dbmod
from app.core.config import Settings, get_settings
from app.models import User
from app.services.cleanup import CleanupService

pytestmark = pytest.mark.asyncio


async def test_physical_purge_deletes_expired_keeps_fresh(client):
    """超期（>30d）软删用户被物理删除；未超期（1d）保留。"""
    now = datetime.now(timezone.utc)
    async with dbmod.AsyncSessionLocal() as s:
        expired = User(
            email="exp@e.com", password_hash="x",
            deleted_at=now - timedelta(days=31),
        )
        fresh = User(
            email="fresh@e.com", password_hash="x",
            deleted_at=now - timedelta(days=1),
        )
        s.add_all([expired, fresh])
        await s.commit()
        await s.refresh(expired)
        await s.refresh(fresh)
        eid, fid = expired.id, fresh.id

    async with dbmod.AsyncSessionLocal() as s:
        deleted = await CleanupService(s).physical_purge()

    async with dbmod.AsyncSessionLocal() as s:
        ids = {u.id for u in (await s.execute(select(User))).scalars().all()}
    assert deleted == 1
    assert eid not in ids
    assert fid in ids


async def test_physical_purge_idempotent(client):
    """重复执行幂等：第二次返回 0（已无超期用户）。"""
    now = datetime.now(timezone.utc)
    async with dbmod.AsyncSessionLocal() as s:
        s.add(User(email="exp2@e.com", password_hash="x",
                   deleted_at=now - timedelta(days=40)))
        await s.commit()

    async with dbmod.AsyncSessionLocal() as s:
        first = await CleanupService(s).physical_purge()
    async with dbmod.AsyncSessionLocal() as s:
        second = await CleanupService(s).physical_purge()
    assert first == 1
    assert second == 0


async def test_sweep_orphan_avatars(client, tmp_path, monkeypatch):
    """未被引用的头像被删；被 user.avatar 引用的保留。"""
    import app.services.cleanup as cleanup_mod

    avatar_dir = tmp_path / "avatar"
    avatar_dir.mkdir()
    orphan = avatar_dir / "11111111-1111-1111-1111-111111111111.jpg"
    referenced = avatar_dir / "22222222-2222-2222-2222-222222222222.png"
    orphan.write_bytes(b"x")
    referenced.write_bytes(b"y")

    async with dbmod.AsyncSessionLocal() as s:
        s.add(User(
            email="av@e.com", password_hash="x",
            avatar="/api/uploads/avatar/22222222-2222-2222-2222-222222222222.png",
        ))
        await s.commit()

    # 把清理服务的 UPLOAD_DIR 指向临时目录
    monkeypatch.setattr(cleanup_mod, "settings", Settings(UPLOAD_DIR=str(tmp_path)))

    async with dbmod.AsyncSessionLocal() as s:
        removed = await CleanupService(s).sweep_orphan_avatars()

    assert removed == 1
    assert not orphan.exists()
    assert referenced.exists()


async def test_sweep_orphan_avatars_skips_non_uuid_files(client, tmp_path, monkeypatch):
    """安全闸门：非 <uuid>.<ext> 命名的文件（历史脏数据 / 穿越）不被删。"""
    import app.services.cleanup as cleanup_mod

    avatar_dir = tmp_path / "avatar"
    avatar_dir.mkdir()
    # 故意放一个非 uuid 文件名 + 一个穿越风格文件名
    (avatar_dir / "random.txt").write_bytes(b"x")
    (avatar_dir / "..-evil.png").write_bytes(b"y")

    monkeypatch.setattr(cleanup_mod, "settings", Settings(UPLOAD_DIR=str(tmp_path)))
    async with dbmod.AsyncSessionLocal() as s:
        removed = await CleanupService(s).sweep_orphan_avatars()

    assert removed == 0
    assert (avatar_dir / "random.txt").exists()
    assert (avatar_dir / "..-evil.png").exists()


async def test_internal_cleanup_requires_token(client):
    """两个清理端点缺令牌均返回 403。"""
    for path in ("/api/internal/cleanup/accounts", "/api/internal/cleanup/avatars"):
        r = await client.post(path)
        assert r.status_code == 403


async def test_internal_cleanup_wrong_token(client):
    """两个清理端点错令牌均返回 403。"""
    for path in ("/api/internal/cleanup/accounts", "/api/internal/cleanup/avatars"):
        r = await client.post(path, headers={"X-Internal-Token": "nope"})
        assert r.status_code == 403


async def test_internal_account_cleanup_runs_with_token(client):
    """账户清理端点：正确令牌触发物理删除，返回 deletedUsers。"""
    now = datetime.now(timezone.utc)
    async with dbmod.AsyncSessionLocal() as s:
        expired = User(
            email="ci@e.com", password_hash="x",
            deleted_at=now - timedelta(days=31),
        )
        s.add(expired)
        await s.commit()
        await s.refresh(expired)
        eid = expired.id

    token = get_settings().INTERNAL_CLEANUP_TOKEN
    r = await client.post(
        "/api/internal/cleanup/accounts", headers={"X-Internal-Token": token}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["code"] == 0
    assert body["data"]["deletedUsers"] == 1

    async with dbmod.AsyncSessionLocal() as s:
        still = (await s.execute(select(User).where(User.id == eid))).scalar_one_or_none()
    assert still is None


async def test_internal_avatar_cleanup_runs_with_token(client, tmp_path, monkeypatch):
    """头像清理端点：正确令牌触发孤儿删除，返回 removedAvatars（与账户解耦）。"""
    import app.services.cleanup as cleanup_mod

    monkeypatch.setattr(cleanup_mod, "settings", Settings(UPLOAD_DIR=str(tmp_path)))

    avatar_dir = tmp_path / "avatar"
    avatar_dir.mkdir()
    # 孤儿头像（无任何用户引用）
    orphan = avatar_dir / "33333333-3333-3333-3333-333333333333.jpg"
    # 被引用的头像（正常用户持有）
    referenced = avatar_dir / "22222222-2222-2222-2222-222222222222.png"
    orphan.write_bytes(b"z")
    referenced.write_bytes(b"y")

    async with dbmod.AsyncSessionLocal() as s:
        s.add(User(
            email="av@e.com", password_hash="x",
            avatar="/api/uploads/avatar/22222222-2222-2222-2222-222222222222.png",
        ))
        await s.commit()

    token = get_settings().INTERNAL_CLEANUP_TOKEN
    r = await client.post(
        "/api/internal/cleanup/avatars", headers={"X-Internal-Token": token}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["code"] == 0
    assert body["data"]["removedAvatars"] == 1
    assert not orphan.exists()
    assert referenced.exists()
