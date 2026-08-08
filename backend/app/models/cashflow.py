"""出入金流水 / 现金余额（对齐 app Prisma: CashFlow / CashBalance）。

CashFlow.type 是 XIRR 现金流唯一来源（买入=负、卖出=正，由计算层按 sign 处理）。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import Date, Enum, ForeignKey, Index, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, CreatedAtMixin, TimestampMixin, pk_uuid
from app.models.enums import CashFlowType


class CashFlow(Base, TimestampMixin):
    __tablename__ = "cashflows"
    __table_args__ = (Index("ix_cashflows_portfolio_date", "portfolio_id", "date"),)

    id: Mapped[str] = pk_uuid()
    portfolio_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("portfolios.id", ondelete="CASCADE"),
        nullable=False,
    )
    date: Mapped[date] = mapped_column(Date, nullable=False)
    type: Mapped[CashFlowType] = mapped_column(
        Enum(CashFlowType, name="CashFlowType", native_enum=True, create_type=True),
        nullable=False,
    )
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    portfolio: Mapped["Portfolio"] = relationship(back_populates="cashflows")


class CashBalance(Base, CreatedAtMixin):
    """现金余额：独立、零联动，仅 createdAt（对齐 Prisma CashBalance 无 updatedAt）。"""

    __tablename__ = "cash_balances"
    __table_args__ = (
        Index("ix_cash_balances_portfolio_asof", "portfolio_id", "as_of"),
    )

    id: Mapped[str] = pk_uuid()
    portfolio_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("portfolios.id", ondelete="CASCADE"),
        nullable=False,
    )
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    as_of: Mapped[date] = mapped_column("as_of", Date, nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    portfolio: Mapped["Portfolio"] = relationship(back_populates="cash_balances")
