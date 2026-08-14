"""标的主数据（目录表）/ 组合持仓表（组合行）/ 证券买卖流水 / 标的最新价。

拆表（ADR-003）：
- ``securities`` 仅作系统级主数据目录表（跨组合共享搜索目录），不再承载组合行；
  删除 ``portfolio_id`` / ``type`` / ``currency`` 列，唯一约束收敛为 ``(asset_class, code)``。
- 新增 ``portfolio_securities`` 组合持仓表，组合私有实例，承载 trades/prices/dividends；
  ``name/exchange`` 经 ``master_id`` JOIN 目录读取，根治「主数据改名不同步组合行」。
- ``type`` 收敛为组合行专属、可空 override（NULL=按代码前缀推断），由序列化层 COALESCE。
"""
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
    """系统级证券主数据目录表（reference data，跨组合共享搜索目录）。

    仅主数据行；组合行已拆至 ``portfolio_securities``。``name/exchange`` 由组合行经
    ``master_id`` JOIN 本表读取，故本表不承担 ``type``（类别维度由 ``asset_class`` 承担）。
    """

    __tablename__ = "securities"
    __table_args__ = (
        # 系统级主数据按 资产类别+code 唯一，避免跨类命名空间碰撞
        UniqueConstraint("asset_class", "code", name="uq_securities_asset_code"),
        # 录入界面证券搜索（code/name/拼音首字母 ILIKE）加速
        Index("ix_securities_pinyin_initials", "pinyin_initials"),
    )

    id: Mapped[str] = pk_uuid()
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # 交易所/市场（SH/SZ/BJ/HK…）；主数据同步填充，缺失时由代码前缀推断
    exchange: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    # 名称拼音首字母（如 贵州茅台→gzm）；录入界面按拼音首字母搜索，同步任务用 pypinyin 计算
    pinyin_initials: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    # 资产类别（复用 SecurityType）；仅用于唯一约束 + 接口配置路由，不参与类型推导
    asset_class: Mapped[Optional[SecurityType]] = mapped_column(
        Enum(SecurityType, name="SecurityType", native_enum=True, create_type=False),
        nullable=True,
    )

    # 组合持仓（master_id → 本目录行）；删除目录行级联删其组合持仓
    holdings: Mapped[list["PortfolioSecurity"]] = relationship(
        back_populates="master", passive_deletes=True
    )


class PortfolioSecurity(Base, TimestampMixin):
    """组合持仓表（原组合行独立成表，ADR-003）。

    ``master_id`` JOIN ``securities`` 读取 ``name/exchange``；``type`` 为可空 override：
    ``NULL``=由代码前缀推断（``infer_security_type``），有值=手动覆盖。
    """

    __tablename__ = "portfolio_securities"
    __table_args__ = (
        UniqueConstraint(
            "portfolio_id", "master_id", name="uq_portfolio_securities_portfolio_master"
        ),
        Index("ix_portfolio_securities_portfolio", "portfolio_id"),
    )

    id: Mapped[str] = pk_uuid()
    portfolio_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("portfolios.id", ondelete="CASCADE"),
        nullable=False,
    )
    master_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("securities.id", ondelete="CASCADE"),
        nullable=False,
    )
    # 资产类型 override：NULL=按代码前缀推断；有值=手动覆盖
    type: Mapped[Optional[SecurityType]] = mapped_column(
        Enum(SecurityType, name="SecurityType", native_enum=True, create_type=False),
        nullable=True,
    )
    currency: Mapped[str] = mapped_column(String(10), default="CNY", nullable=False)

    master: Mapped["Security"] = relationship(back_populates="holdings")
    portfolio: Mapped["Portfolio"] = relationship(
        back_populates="securities", passive_deletes=True
    )
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
        ForeignKey("portfolio_securities.id", ondelete="CASCADE"),
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
    security: Mapped["PortfolioSecurity"] = relationship(back_populates="trades")


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
        ForeignKey("portfolio_securities.id", ondelete="CASCADE"),
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
    security: Mapped["PortfolioSecurity"] = relationship(back_populates="prices")
