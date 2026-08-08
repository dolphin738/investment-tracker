"""总资产每日唯一记录表（对齐 app Prisma: AssetSnapshot）。

派生层 + 手工录入；唯一键 (portfolio_id, date)。recorded_at 为记录写入时间，
与 created_at/updated_at 并列（Prisma 三列独立）。
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, pk_uuid
from app.models.enums import SnapshotSource, SnapshotValuation


class AssetSnapshot(Base, TimestampMixin):
    __tablename__ = "asset_snapshots"
    __table_args__ = (
        UniqueConstraint("portfolio_id", "date", name="uq_asset_snapshots_portfolio_date"),
        Index("ix_asset_snapshots_portfolio_date", "portfolio_id", "date"),
    )

    id: Mapped[str] = pk_uuid()
    portfolio_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("portfolios.id", ondelete="CASCADE"),
        nullable=False,
    )
    date: Mapped[date] = mapped_column(Date, nullable=False)
    total_asset: Mapped[Decimal] = mapped_column(
        "total_asset", Numeric(18, 2), nullable=False
    )
    market_value: Mapped[Decimal | None] = mapped_column(
        "market_value", Numeric(18, 2), nullable=True
    )
    cash_balance: Mapped[Decimal | None] = mapped_column(
        "cash_balance", Numeric(18, 2), nullable=True
    )
    source: Mapped[SnapshotSource] = mapped_column(
        Enum(SnapshotSource, name="SnapshotSource", native_enum=True, create_type=True),
        nullable=False,
    )
    valuation_flag: Mapped[SnapshotValuation] = mapped_column(
        "valuation_flag",
        Enum(SnapshotValuation, name="SnapshotValuation", native_enum=True, create_type=True),
        nullable=False,
    )
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    recorded_at: Mapped[datetime] = mapped_column(
        "recorded_at",
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    portfolio: Mapped["Portfolio"] = relationship(back_populates="snapshots")
