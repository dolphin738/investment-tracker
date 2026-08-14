"""投资组合表（对齐 app Prisma: Portfolio）。"""
from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKey, String, Text, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, pk_uuid


class Portfolio(Base, TimestampMixin):
    __tablename__ = "portfolios"
    __table_args__ = (Index("ix_portfolios_user_id", "user_id"),)

    id: Mapped[str] = pk_uuid()
    user_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    base_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    currency: Mapped[str] = mapped_column(String(10), default="CNY", nullable=False)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped["User"] = relationship(back_populates="portfolios")
    cashflows: Mapped[list["CashFlow"]] = relationship(
        back_populates="portfolio", passive_deletes=True
    )
    securities: Mapped[list["PortfolioSecurity"]] = relationship(
        back_populates="portfolio", passive_deletes=True
    )
    security_trades: Mapped[list["SecurityTrade"]] = relationship(
        back_populates="portfolio", passive_deletes=True
    )
    security_prices: Mapped[list["SecurityPrice"]] = relationship(
        back_populates="portfolio", passive_deletes=True
    )
    cash_balances: Mapped[list["CashBalance"]] = relationship(
        back_populates="portfolio", passive_deletes=True
    )
    snapshots: Mapped[list["AssetSnapshot"]] = relationship(
        back_populates="portfolio", passive_deletes=True
    )
    daily_navs: Mapped[list["DailyNav"]] = relationship(
        back_populates="portfolio", passive_deletes=True
    )
    daily_xirrs: Mapped[list["DailyXirr"]] = relationship(
        back_populates="portfolio", passive_deletes=True
    )
    dividends: Mapped[list["DividendRecord"]] = relationship(
        back_populates="portfolio", passive_deletes=True
    )
