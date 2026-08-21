"""LOG_CLEANUP 分级清理测试（验收点 C）。

直接调 ``scheduler._log_cleanup(cfg)``，用 cfg.params 控制保留策略使用例确定：
- notifications：仅删「已读且超期」，未读永不删；
- app_logs：逐 level 过期删除 + 超量（max_rows）删除（高级别按各自策略）。
"""
from __future__ import annotations

import pytest
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

import pytest_asyncio

import app.db.database as dbmod
from app.core.scheduler import _log_cleanup
from app.models.job import JobConfig
from app.models.log import AppLog
from app.models.notification import Notification

pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture(autouse=True)
async def _bind_test_sessionmaker(_engine):
    """见 test_log_center.py 同名校验：把 scheduler 模块级 AsyncSessionLocal 重绑到
    测试库 maker，确保 _log_cleanup 在测试库内运行，不触碰开发库。"""
    import app.core.scheduler as scheduler_mod

    scheduler_mod.AsyncSessionLocal = dbmod.AsyncSessionLocal
    yield


async def _seed_notifications() -> tuple:
    """三种状态各一条：read+expired / read+fresh / unread+expired。返回 (ids)。"""
    now = datetime.now(timezone.utc)
    async with dbmod.AsyncSessionLocal() as s:
        read_expired = Notification(
            level="info", title="re", message="read expired",
            read=True, created_at=now - timedelta(days=40),
        )
        read_fresh = Notification(
            level="info", title="rf", message="read fresh",
            read=True, created_at=now - timedelta(days=1),
        )
        unread_expired = Notification(
            level="warning", title="ue", message="unread expired",
            read=False, created_at=now - timedelta(days=40),
        )
        s.add_all([read_expired, read_fresh, unread_expired])
        await s.commit()
        await s.refresh(read_expired)
        await s.refresh(read_fresh)
        await s.refresh(unread_expired)
    return read_expired.id, read_fresh.id, unread_expired.id


async def _notif_exists(nid: str) -> bool:
    async with dbmod.AsyncSessionLocal() as s:
        return (
            await s.execute(
                select(Notification).where(Notification.id == nid)
            )
        ).scalar_one_or_none() is not None


async def test_cleanup_notifications_only_read_expired(client):
    """notifications 仅清「已读超期」：read+expired 删、read+fresh 留、未读+超期留。"""
    re_id, rf_id, ue_id = await _seed_notifications()
    cfg = JobConfig(
        name="cleanup-test", task_type="LOG_CLEANUP", kind="SYSTEM",
        cron_expr="0 0 * * *",
        params={"notifications_retention_days": 30},
    )
    await _log_cleanup(cfg)

    assert not await _notif_exists(re_id)   # 已读超期 → 删
    assert await _notif_exists(rf_id)        # 已读未超期 → 留
    assert await _notif_exists(ue_id)        # 未读超期 → 留（未读永不删）


async def _count_level(level: str) -> int:
    async with dbmod.AsyncSessionLocal() as s:
        return int(
            (await s.execute(
                select(func.count()).select_from(AppLog).where(AppLog.level == level)
            )).scalar_one()
        )


async def test_cleanup_app_logs_retention_and_max_rows(client):
    """app_logs 分级：过期 error 删；info 超 max_rows 按量裁剪，其余 level 不受影响。"""
    now = datetime.now(timezone.utc)
    async with dbmod.AsyncSessionLocal() as s:
        # error 已超期（retention error=2d），应被过期删除
        s.add(AppLog(level="error", scope="error", module="m", message="err-old",
                     created_at=now - timedelta(days=10)))
        # error 未超期，保留
        s.add(AppLog(level="error", scope="error", module="m", message="err-new",
                     created_at=now - timedelta(days=1)))
        # info 超量：max_rows info=2，seed 5 条（均新鲜），应裁到 2 条
        for i in range(5):
            s.add(AppLog(level="info", scope="operation", module="m",
                         message=f"info-{i}", created_at=now - timedelta(hours=i + 1)))
        # warning 不参与本例裁剪（retention 30d 未超、max_rows 很大），保留
        s.add(AppLog(level="warning", scope="system", module="m",
                     message="warn-keep", created_at=now))
        await s.commit()

    cfg = JobConfig(
        name="cleanup-test2", task_type="LOG_CLEANUP", kind="SYSTEM",
        cron_expr="0 0 * * *",
        params={
            "retention_days": {"error": 2, "warning": 30, "info": 7},
            "max_rows": {"error": 20000, "warning": 10000, "info": 2},
        },
    )
    await _log_cleanup(cfg)

    # error 过期删除后只剩 1 条（err-new）
    assert await _count_level("error") == 1
    # info 超量裁剪：5 条 seed 裁到 max_rows=2；裁剪后再写一条 info 汇总审计日志，
    # 故「info seed」应剩 2 条，总 info = 3（含汇总）。
    async with dbmod.AsyncSessionLocal() as s:
        seed_info = int(
            (await s.execute(
                select(func.count()).select_from(AppLog)
                .where(AppLog.level == "info", AppLog.message.like("info-%"))
            )).scalar_one()
        )
    assert seed_info == 2
    assert await _count_level("info") == 3
    # warning 不受影响
    assert await _count_level("warning") == 1
