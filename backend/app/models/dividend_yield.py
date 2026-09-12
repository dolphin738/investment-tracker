"""股息率排名数据模型（§5）。

五张表：
- ``security_dividends``：分红事件（按报告期季度粒度，5 年留存）
- ``market_security_daily_prices``：市场级日线收盘价（不复权）
- ``security_dividend_yields``：派生快照（每证券一行，事件驱动重算）
- ``dividend_yield_settings``：全局配置（单行：阈值 + 主源/补充源/行情源）
- ``market_trade_calendar``：交易日历

命名约束（§4）：本模块一律使用 ``master_id`` 指向 ``securities`` 主数据目录行，
**不得**使用 ``security_id``（后者在本仓库一律指持仓行 ``portfolio_securities.id``）。
股息率为小数比率（0.05 = 5%），分子为每股（元）。
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    SmallInteger,
    String,
    UniqueConstraint,
    false,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, CreatedAtMixin, TimestampMixin, pk_uuid
from app.models.enums import DividendStatus, DividendYieldMode, ReportPeriodType


class SecurityDividend(Base, TimestampMixin):
    """分红事件表（§5.1）。唯一键含 ``period_type``：SPECIAL 补充行与报告期行可同格并存。"""

    __tablename__ = "security_dividends"
    __table_args__ = (
        UniqueConstraint(
            "master_id",
            "report_year",
            "report_quarter",
            "period_type",
            name="uq_security_dividends_master_period",
        ),
        Index("ix_security_dividends_master", "master_id"),
        Index("ix_security_dividends_report", "report_year", "report_quarter"),
    )

    id: Mapped[str] = pk_uuid()
    # 主数据目录行（ADR-003），非持仓行；配合主数据自愈（先迁移引用再改 securities.id）延迟检查
    master_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey(
            "securities.id",
            ondelete="CASCADE",
            deferrable=True,
            initially="DEFERRED",
        ),
        nullable=False,
    )
    report_year: Mapped[int] = mapped_column(Integer, nullable=False)
    report_quarter: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, comment="季度报告期 1~4（半年报=2、年报=4）"
    )
    period_type: Mapped[ReportPeriodType] = mapped_column(
        Enum(ReportPeriodType, name="ReportPeriodType", native_enum=True, create_type=False),
        nullable=False,
    )
    # 每股现金分红（元；源为「每 10 股派 X 元」时除以 10 折算，§6.1）
    cash_per_share: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    status: Mapped[DividendStatus] = mapped_column(
        Enum(DividendStatus, name="DividendStatus", native_enum=True, create_type=False),
        nullable=False,
    )
    # 除权除息日（非派息日，§3.4）；曲线归位锚点
    ex_dividend_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    # 公告日期：SPECIAL 行的财年/季度落格锚点（§2.1）；东财报告期行可空
    announcement_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    # 股权登记日（可选，更精确的归位锚点备用）
    record_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    # 来源接口名（不采信东财股息率，仅作附注）
    source: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)


class MarketSecurityDailyPrice(Base, CreatedAtMixin):
    """市场级日线收盘价表（§5.2，不复权）。唯一键 ``(master_id, trade_date)``。"""

    __tablename__ = "market_security_daily_prices"
    __table_args__ = (
        UniqueConstraint("master_id", "trade_date", name="uq_market_daily_price_master_date"),
        Index("ix_market_daily_price_master_date", "master_id", "trade_date"),
    )

    id: Mapped[str] = pk_uuid()
    master_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey(
            "securities.id",
            ondelete="CASCADE",
            deferrable=True,
            initially="DEFERRED",
        ),
        nullable=False,
    )
    trade_date: Mapped[date] = mapped_column(Date, nullable=False)
    close: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    source: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    fetched_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class SecurityDividendYield(Base, TimestampMixin):
    """派生快照表（§5.3）。每证券一行、仅存最新派生值；事件驱动重建。"""

    __tablename__ = "security_dividend_yields"
    __table_args__ = (
        # 排名主查询：股息率降序（NULL 排末尾）+ master_id 稳定 tiebreaker（§8.1 强制式，
        # 实际落库见 0005 迁移——带 DESC NULLS LAST 的表达式索引，text() 形式与迁移一致）
        Index(
            "ix_dividend_yields_rank",
            text("dividend_yield DESC NULLS LAST"),
            text("master_id ASC"),
        ),
        # 连续分红榜排序（§8.3 榜二三元组）
        Index(
            "ix_dividend_yields_consecutive",
            text("consecutive_years DESC NULLS LAST"),
            text("dividend_yield DESC NULLS LAST"),
            text("master_id ASC"),
        ),
    )

    id: Mapped[str] = pk_uuid()
    master_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey(
            "securities.id",
            ondelete="CASCADE",
            deferrable=True,
            initially="DEFERRED",
        ),
        nullable=False,
        unique=True,
    )
    mode: Mapped[DividendYieldMode] = mapped_column(
        Enum(DividendYieldMode, name="DividendYieldMode", native_enum=True, create_type=False),
        nullable=False,
    )
    # 分子（每股，元）；缺失为 NULL
    numerator_per_share: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(18, 6), nullable=True
    )
    # 股息率（小数比率，0.05=5%）；分母缺失为 NULL
    dividend_yield: Mapped[Optional[Decimal]] = mapped_column(Numeric(18, 6), nullable=True)
    latest_price: Mapped[Optional[Decimal]] = mapped_column(Numeric(18, 6), nullable=True)
    latest_trade_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    # 连续分红年数（SmallInt，≤5，定义见 §8.2）
    consecutive_years: Mapped[Optional[int]] = mapped_column(SmallInteger, nullable=True)
    # 最近一次有分红的财年（"近两年无分红"判定，§8.2）
    last_dividend_year: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # 参与计算的分红记录 id 清单（审计/定点重算，data-lineage）
    ref_div_ids: Mapped[Optional[list[Any]]] = mapped_column(JSONB, nullable=True)
    # 陈旧标记：源不可达时保留旧值并置 true，前端标灰
    stale: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=false())
    # 异常股息率标记（A12）：yield<=0 或 yield>0.30 置 true；不入 Top20，管理页标警示
    suspicious: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=false())
    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        server_default=func.now(),
    )


class DividendYieldSettings(Base, TimestampMixin):
    """全局配置表（§5.4，单行）。

    数据源决定后台采集任务从哪个接口抓数，为系统级配置；独立于 per-user 偏好表。
    """

    __tablename__ = "dividend_yield_settings"

    id: Mapped[str] = pk_uuid()
    # 阈值（小数比率，0.03=3%，0.05=5%）
    green_threshold: Mapped[Decimal] = mapped_column(Numeric(5, 4), nullable=False, default=Decimal("0.05"))
    red_threshold: Mapped[Decimal] = mapped_column(Numeric(5, 4), nullable=False, default=Decimal("0.03"))
    # 主源（分类 3，按报告期全量形态）；补充源（分类 3，按证券逐只形态）；行情源（分类 2）
    dividend_report_source_interface_id: Mapped[Optional[str]] = mapped_column(
        String(36),
        ForeignKey("quote_provider_interfaces.id", ondelete="SET NULL"),
        nullable=True,
    )
    dividend_detail_source_interface_id: Mapped[Optional[str]] = mapped_column(
        String(36),
        ForeignKey("quote_provider_interfaces.id", ondelete="SET NULL"),
        nullable=True,
    )
    price_source_interface_id: Mapped[Optional[str]] = mapped_column(
        String(36),
        ForeignKey("quote_provider_interfaces.id", ondelete="SET NULL"),
        nullable=True,
    )
    # 公告源（分类 4，公司公告扫描 §6.8 取代原写死分类 4）
    announcement_source_interface_id: Mapped[Optional[str]] = mapped_column(
        String(36),
        ForeignKey("quote_provider_interfaces.id", ondelete="SET NULL"),
        nullable=True,
    )
    # 历史行情回补源（分类 2，证券行情；路线 B akshare stock_zh_a_hist 历史日线回补，
    # 决策 A15，全池慢速，须接入方式 sdk）
    price_backfill_source_interface_id: Mapped[Optional[str]] = mapped_column(
        String(36),
        ForeignKey("quote_provider_interfaces.id", ondelete="SET NULL"),
        nullable=True,
    )
    updated_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)


class MarketTradeCalendar(Base):
    """交易日历表（§5.5）。主键即交易日。"""

    __tablename__ = "market_trade_calendar"

    trade_date: Mapped[date] = mapped_column(Date, primary_key=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        server_default=func.now(),
    )