"""每日净值 / 每日 XIRR（对齐 app Prisma: DailyNav / DailyXirr）。

均为派生层结果，唯一键 (portfolio_id, date)。XIRR 精度 NUMERIC(20,8)。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import Date, ForeignKey, Index, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, pk_uuid


class DailyNav(Base, TimestampMixin):
    __tablename__ = "daily_nav"
    __table_args__ = (
        UniqueConstraint("portfolio_id", "date", name="uq_daily_nav_portfolio_date"),
        Index("ix_daily_nav_portfolio_date", "portfolio_id", "date"),
    )

    id: Mapped[str] = pk_uuid()
    portfolio_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("portfolios.id", ondelete="CASCADE"),
        nullable=False,
    )
    date: Mapped[date] = mapped_column(Date, nullable=False)
    unit_nav: Mapped[Decimal] = mapped_column(
        "unit_nav", Numeric(12, 6), nullable=False
    )
    cumulative_nav: Mapped[Decimal] = mapped_column(
        "cumulative_nav", Numeric(12, 6), nullable=False
    )
    year_nav: Mapped[Decimal] = mapped_column(
        "year_nav", Numeric(12, 6), nullable=False
    )
    shares: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    base_cumulative_nav: Mapped[Decimal | None] = mapped_column(
        "base_cumulative_nav", Numeric(12, 6), nullable=True
    )

    portfolio: Mapped["Portfolio"] = relationship(back_populates="daily_navs")


class DailyXirr(Base, TimestampMixin):
    __tablename__ = "daily_xirr"
    __table_args__ = (
        UniqueConstraint("portfolio_id", "date", name="uq_daily_xirr_portfolio_date"),
        Index("ix_daily_xirr_portfolio_date", "portfolio_id", "date"),
    )

    id: Mapped[str] = pk_uuid()
    portfolio_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("portfolios.id", ondelete="CASCADE"),
        nullable=False,
    )
    date: Mapped[date] = mapped_column(Date, nullable=False)
    xirr_value: Mapped[Decimal | None] = mapped_column(
        "xirr_value", Numeric(20, 8), nullable=True
    )

    portfolio: Mapped["Portfolio"] = relationship(back_populates="daily_xirrs")
