"""标的主数据 / 证券买卖流水 / 标的最新价（对齐 app Prisma: Security / SecurityTrade / SecurityPrice）。"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import (
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, CreatedAtMixin, TimestampMixin, pk_uuid
from app.models.enums import SecuritySide, SecurityType


class Security(Base, TimestampMixin):
    __tablename__ = "securities"
    __table_args__ = (
        UniqueConstraint("portfolio_id", "code", name="uq_securities_portfolio_code"),
    )

    id: Mapped[str] = pk_uuid()
    portfolio_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("portfolios.id", ondelete="CASCADE"),
        nullable=False,
    )
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    type: Mapped[SecurityType] = mapped_column(
        Enum(SecurityType, name="SecurityType", native_enum=True, create_type=True),
        default=SecurityType.STOCK,
        nullable=False,
    )
    currency: Mapped[str] = mapped_column(String(10), default="CNY", nullable=False)

    portfolio: Mapped["Portfolio"] = relationship(back_populates="securities")
    trades: Mapped[list["SecurityTrade"]] = relationship(
        back_populates="security", passive_deletes=True
    )
    prices: Mapped[list["SecurityPrice"]] = relationship(
        back_populates="security", passive_deletes=True
    )
    dividends: Mapped[list["DividendRecord"]] = relationship(
        back_populates="security", passive_deletes=True
    )


class SecurityTrade(Base, TimestampMixin):
    __tablename__ = "security_trades"
    __table_args__ = (
        Index("ix_security_trades_portfolio_date", "portfolio_id", "date"),
        Index("ix_security_trades_security_date", "security_id", "date"),
    )

    id: Mapped[str] = pk_uuid()
    portfolio_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("portfolios.id", ondelete="CASCADE"),
        nullable=False,
    )
    security_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("securities.id", ondelete="CASCADE"),
        nullable=False,
    )
    date: Mapped[date] = mapped_column(Date, nullable=False)
    side: Mapped[SecuritySide] = mapped_column(
        Enum(SecuritySide, name="SecuritySide", native_enum=True, create_type=True),
        nullable=False,
    )
    quantity: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    cost_price: Mapped[Decimal] = mapped_column(
        "cost_price", Numeric(18, 6), nullable=False
    )
    fee_total: Mapped[Decimal] = mapped_column(
        "fee_total", Numeric(18, 2), default=0, nullable=False
    )
    commission: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=0, nullable=False)
    stamp_tax: Mapped[Decimal] = mapped_column(
        "stamp_tax", Numeric(18, 2), default=0, nullable=False
    )
    other: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=0, nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    portfolio: Mapped["Portfolio"] = relationship(back_populates="security_trades")
    security: Mapped["Security"] = relationship(back_populates="trades")


class SecurityPrice(Base, CreatedAtMixin):
    """标的最新价：仅 createdAt（对齐 Prisma SecurityPrice 无 updatedAt）。"""

    __tablename__ = "security_prices"
    __table_args__ = (
        Index(
            "ix_security_prices_portfolio_security_asof",
            "portfolio_id",
            "security_id",
            "as_of",
        ),
    )

    id: Mapped[str] = pk_uuid()
    portfolio_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("portfolios.id", ondelete="CASCADE"),
        nullable=False,
    )
    security_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("securities.id", ondelete="CASCADE"),
        nullable=False,
    )
    price: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    as_of: Mapped[date] = mapped_column("as_of", Date, nullable=False)
    # —— 实时行情数据时效（ADR-002 §2.2）：支撑"数据截至 HH:MM · 来源"与过旧红点判断 ——
    fetched_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True, comment="行情拉取时间（区分日内拉取时刻）"
    )
    source: Mapped[Optional[str]] = mapped_column(
        String(64), nullable=True, comment="价来源：接口名（如 小熊同学/stock）/ 手动上传"
    )

    portfolio: Mapped["Portfolio"] = relationship(back_populates="security_prices")
    security: Mapped["Security"] = relationship(back_populates="prices")
