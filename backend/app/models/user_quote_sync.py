"""用户个性化行情同步配置表。

把行情自动同步从「管理员全局普通任务」改造为「每个用户自己的配置
（按日/周/月周期，只同步自己的组合）」，仍由 APScheduler 统一调度。

- ``user_id`` 为主键；同一用户仅一条配置（upsert）。
- ``frequency``：DAY / WEEK / MONTH（String 简存，不用 PG 原生枚举）。
- ``weekday``（1=周一..7=周日，仅 WEEK 有效）、``day_of_month``（1..31，仅 MONTH 有效）。
- ``last_*`` 记录最近一次自动同步的执行结果（不写 job_run_logs）。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, false, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin


class UserQuoteSyncConfig(Base, TimestampMixin):
    __tablename__ = "user_quote_sync_configs"

    user_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
    # DAY / WEEK / MONTH
    frequency: Mapped[str] = mapped_column(
        String(6), nullable=False, default="DAY", server_default=text("'DAY'")
    )
    # 触发时刻 "HH:MM"
    time: Mapped[str] = mapped_column(
        String(5), nullable=False, default="09:00", server_default=text("'09:00'")
    )
    # 周几触发（1=周一..7=周日，仅 WEEK 有效）
    weekday: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # 每月几号触发（1..31，仅 MONTH 有效）
    day_of_month: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # RUNNING / SUCCESS / FAILED
    last_status: Mapped[str | None] = mapped_column(String(10), nullable=True)
    last_message: Mapped[str | None] = mapped_column(String(512), nullable=True)