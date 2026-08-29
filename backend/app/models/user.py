"""用户表 + 用户偏好表（对齐 app Prisma: User / UserPreference）。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy import JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import UserRole
from app.db.base import Base, TimestampMixin, pk_uuid


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[str] = pk_uuid()
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    avatar: Mapped[str | None] = mapped_column(String(512), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(20), nullable=True)
    bio: Mapped[str | None] = mapped_column(String(200), nullable=True)
    role: Mapped[str] = mapped_column(
        String(20), default=UserRole.USER.value, nullable=False
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # JWT 吊销版本号（REP-011）：改密/改邮箱/恢复账户时自增，旧 token 因 tv 不匹配即失效。
    token_version: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    portfolios: Mapped[list["Portfolio"]] = relationship(
        back_populates="user", passive_deletes=True
    )
    preference: Mapped["UserPreference | None"] = relationship(
        back_populates="user", uselist=False, passive_deletes=True
    )


class UserPreference(Base, TimestampMixin):
    __tablename__ = "user_preferences"
    __table_args__ = (UniqueConstraint("user_id", name="uq_user_preferences_user_id"),)

    id: Mapped[str] = pk_uuid()
    user_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    default_portfolio_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    default_granularity: Mapped[str] = mapped_column(String(20), default="month", nullable=False)
    default_date_range: Mapped[str] = mapped_column(String(20), default="1y", nullable=False)
    aggregation: Mapped[str] = mapped_column(String(20), default="last", nullable=False)
    week_starts_on: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    nav_decimals: Mapped[int] = mapped_column(Integer, default=4, nullable=False)
    xirr_decimals: Mapped[int] = mapped_column(Integer, default=2, nullable=False)
    theme: Mapped[str] = mapped_column(String(20), default="system", nullable=False)
    stale_days: Mapped[int] = mapped_column(Integer, default=3, nullable=False)
    show_liquidated: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    cost_basis_view: Mapped[str] = mapped_column(String(20), default="avg", nullable=False)
    cash_hint_on_cashflow: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    cash_hint_on_trade: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    amount_thousands: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    amount_abbrev: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    dashboard_layout: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    user: Mapped["User"] = relationship(back_populates="preference")
