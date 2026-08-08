"""分红记录（对齐 app Prisma: DividendRecord）。

不参与收益计算（C-08/C-09）；tax 为所得税增量列，存量默认 0。
仅 createdAt（无 updatedAt）。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import Date, Enum, ForeignKey, Index, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, CreatedAtMixin, pk_uuid
from app.models.enums import DividendType


class DividendRecord(Base, CreatedAtMixin):
    __tablename__ = "dividend_records"
    __table_args__ = (
        Index("ix_dividend_records_portfolio_date", "portfolio_id", "date"),
        Index("ix_dividend_records_security_date", "security_id", "date"),
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
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    tax: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=0, nullable=False)
    type: Mapped[DividendType] = mapped_column(
        Enum(DividendType, name="DividendType", native_enum=True, create_type=True),
        default=DividendType.CASH,
        nullable=False,
    )
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    portfolio: Mapped["Portfolio"] = relationship(back_populates="dividends")
    security: Mapped["Security"] = relationship(back_populates="dividends")
