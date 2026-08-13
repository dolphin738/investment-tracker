"""站内信通知服务 — 列表 / 已读标记 / 创建。

仅做 CRUD 与持久化；**不实现**任何阈值 / claim / 去重逻辑（那是
``MarketDataSyncService._mark_failure`` 的职责，仅在抢到告警后调用本服务的
``create`` 写入一条通知）。
"""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import HTTPException
from sqlalchemy import select

from app.models.notification import Notification


class NotificationService:
    def __init__(self, session) -> None:
        self.session = session

    async def list_all(self, limit: int = 50) -> list[Notification]:
        """按 created_at 倒序返回通知列表（默认最多 50 条）。"""
        result = await self.session.execute(
            select(Notification)
            .order_by(Notification.created_at.desc())
            .limit(limit)
        )
        return list(result.scalars().all())

    async def list_unread(self) -> list[Notification]:
        """返回全部未读通知（read=false）。"""
        result = await self.session.execute(
            select(Notification)
            .where(Notification.read == False)  # noqa: E712
            .order_by(Notification.created_at.desc())
        )
        return list(result.scalars().all())

    async def mark_read(self, notification_id: str) -> Notification:
        """标记单条通知为已读；不存在 → 404。"""
        obj = await self.session.get(Notification, notification_id)
        if obj is None:
            raise HTTPException(status_code=404, detail="通知不存在")
        obj.read = True
        await self.session.flush()
        return obj

    async def create(
        self,
        *,
        level: str,
        title: str,
        message: str,
        related_type: Optional[str] = None,
        related_id: Optional[str] = None,
    ) -> Notification:
        """插入一条通知并 flush（提交由调用方 / 端点负责）。

        显式生成 id（Python 端 uuid4），保证 flush 后即可在会话内取回 id，
        不依赖 DB server_default 回填。
        """
        obj = Notification(
            id=str(uuid.uuid4()),
            level=level,
            title=title,
            message=message,
            related_type=related_type,
            related_id=related_id,
        )
        self.session.add(obj)
        await self.session.flush()
        return obj
