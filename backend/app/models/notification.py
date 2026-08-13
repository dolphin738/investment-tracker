"""站内信通知模型 — 管理面告警落点（ADR-002 §3 Q2 默认「管理面站内信」）。

告警由 ``MarketDataSyncService._mark_failure`` 在抢到告警（claim）成功后写入：
- ``level``：warning | info | error（默认 warning）。
- ``related_type`` / ``related_id``：关联对象类型与 id（如 ``'quote_interface'`` / 接口 id），
  便于前端铃铛点击跳转到对应接口编辑页。
- ``read``：是否已读（全局共享，所有 admin 可见同一列表、可标已读）。
- ``created_at``：由 ``CreatedAtMixin`` 提供（DB server_default + Python 端默认）。
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import Boolean, String, Text, false
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, CreatedAtMixin, pk_uuid


class Notification(Base, CreatedAtMixin):
    __tablename__ = "notifications"

    id: Mapped[str] = pk_uuid()
    level: Mapped[str] = mapped_column(
        String(20), nullable=False, default="warning", server_default="warning"
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    related_type: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    related_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    read: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
