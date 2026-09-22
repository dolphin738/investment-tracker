"""股息率排名数据模型（§5）。

六张表：
- ``security_dividends``：分红事件（按报告期季度粒度，5 年留存）
- ``market_security_daily_prices``：市场级日线收盘价（不复权）
- ``security_dividend_yields``：派生快照（每证券一行，事件驱动重算）
- ``dividend_yield_settings``：全局配置（单行：股息明细源接口/行情源/公司公告接口）
- ``market_trade_calendar``：交易日历
- ``security_dividend_pending``：待人工划分分红 staging 队列（批次 B）

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
from app.models.enums import (
    DividendPendingStatus,
    DividendStatus,
    DividendYieldMode,
    ReportPeriodType,
)


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
    # 每股送股比例（送红股）：源站口径为「每 10 股送 X 股」，落库时已除以 10 折算为每股，
    # 与 cash_per_share 的单位口径保持一致；巨潮无值或空/NaN 时为 NULL。
    bonus_share_ratio: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(18, 6), nullable=True
    )
    # 每股转增比例（资本公积转增股本）：源站口径为「每 10 股转 X 股」，落库时已除以 10
    # 折算为每股；巨潮无值或空/NaN 时为 NULL。用途见方案 §5.3.1（除权复权重述因子）。
    convert_ratio: Mapped[Optional[Decimal]] = mapped_column(Numeric(18, 6), nullable=True)
    # 原文「分红类型」标签（如「股改分红」「重整转增」）：展示与撞键判别用，**不入唯一键**
    dividend_label: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)


class SecurityDividendPending(Base, TimestampMixin):
    """待人工划分分红 staging 表（批次 B，§3.1）。

    承接巨潮「现金>0 但报告时间不可解析」的行（``parse_cninfo_row_ex`` 的 ``no_period``
    桶）：源站报告期词表不可解析，无法落主表唯一键，故先入队待人工裁定报告期后再写回
    ``security_dividends``。

    幂等键为 ``row_fingerprint``（sha1 hex，40 字符）单列唯一——**刻意不用复合唯一键**：
    复合键含可空日期，PG 唯一索引对 NULL 视为互不相等，无法幂等（§3.6）。

    ``resolved_period_type`` **刻意用 ``String(16)`` 非原生枚举**：避免枚举值演进触发
    PG 类型重建（§9.1）。**不保留** ``股份到账日`` / ``实施方案分红说明``（§9.3-A6）。
    """

    __tablename__ = "security_dividend_pending"
    __table_args__ = (
        # 幂等键（ON CONFLICT 目标）；单列唯一，规避「复合键含可空日期 → NULL 不相等」
        Index(
            "uq_security_dividend_pending_fingerprint",
            "row_fingerprint",
            unique=True,
        ),
        Index("ix_security_dividend_pending_status", "status"),
        Index("ix_security_dividend_pending_master", "master_id"),
    )

    id: Mapped[str] = pk_uuid()
    # 主数据目录行（ADR-003），非持仓行；与 SecurityDividend.master_id 同口径（延迟检查）
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
    # sha1 hex 幂等键（唯一）：同源行重复 scan → 同指纹（§3.6）
    row_fingerprint: Mapped[str] = mapped_column(String(40), nullable=False)
    # 源站「分红类型」原文（normalize_label 截断 32）；供人工判读
    dividend_label: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    # 每股派息（元；源「每 10 股」÷10，与 SecurityDividend.cash_per_share 同口径）
    cash_per_share: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    # 每股送股比例（源「每 10 股送 X 股」÷10）；缺失为 NULL
    bonus_share_ratio: Mapped[Optional[Decimal]] = mapped_column(Numeric(18, 6), nullable=True)
    # 每股转增比例（源「每 10 股转 X 股」÷10）；缺失为 NULL
    convert_ratio: Mapped[Optional[Decimal]] = mapped_column(Numeric(18, 6), nullable=True)
    record_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    ex_dividend_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    # 派息日（SecurityDividend 未落，pending 保留，§5.2）
    pay_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    announcement_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    # 「报告时间」原文（不可解析故入 staging，保留原样供人工判读）
    report_period_raw: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    status: Mapped[DividendPendingStatus] = mapped_column(
        Enum(
            DividendPendingStatus,
            name="DividendPendingStatus",
            native_enum=True,
            create_type=False,
        ),
        nullable=False,
        default=DividendPendingStatus.PENDING,
        server_default=text("'PENDING'"),
    )
    # 人工裁定后的报告期类型（存 ReportPeriodType 的 .value 字符串）；刻意非 native enum
    resolved_period_type: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    resolved_report_year: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    resolved_report_quarter: Mapped[Optional[int]] = mapped_column(SmallInteger, nullable=True)
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)


class MarketSecurityDailyPrice(Base, CreatedAtMixin):
    """市场级日线收盘价表（§5.2，不复权）。唯一键 ``(master_id, trade_date)``。"""

    __tablename__ = "market_security_daily_prices"
    # 唯一约束在 PG 内部即一棵唯一 btree 索引，与同列的普通索引完全等价，
    # 故不再重复声明普通索引（原 ix_market_daily_price_master_date 已由 0025 下线）：
    # 少维护一棵 btree，每年省约 70MB，且不影响 (master_id, trade_date) 的任何查询计划。
    __table_args__ = (
        UniqueConstraint("master_id", "trade_date", name="uq_market_daily_price_master_date"),
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
    # 注：股息率标色阈值已迁至「用户偏好」user_preferences.green/red_threshold（0026 迁移），
    # 本表不再承载；对应两列由 0027 迁移删除。
    # 股息明细源接口（分类 3，按证券逐只形态）；行情源（分类 2）
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
    # 公司公告接口（分类 4，公司公告扫描 §6.8 取代原写死分类 4）
    announcement_source_interface_id: Mapped[Optional[str]] = mapped_column(
        String(36),
        ForeignKey("quote_provider_interfaces.id", ondelete="SET NULL"),
        nullable=True,
    )
    # 交易日历刷新起始日期（YYYY-MM-DD）：全局设置可配，决定 refresh_trade_calendar 的
    # 窗口下限（只落该日及之后的交易日）；None = 用默认下限「去年 1 月 1 日」。
    # 不暴露「结束日期」：akshare tool_trade_date_hist_sina 只给到当年末，配上限也拿不到数据。
    trade_calendar_start_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    # 分红留存窗年数（D-4 配置化）：retention_cleanup 保留 [cur-years+1, cur] 个财年；
    # 可空 + server_default '5'（存量行自动获 5；显式 NULL 语义为「用默认值」）。
    # 默认值全局唯一定义于模块级 ``DEFAULT_DIVIDEND_RETENTION_YEARS``（与 server_default 一致），
    # 采集窗（retention_cutoff_year）与清理窗（retention_cleanup）均回落它，避免多处硬编码 5 漂移。
    dividend_retention_years: Mapped[Optional[int]] = mapped_column(
        Integer, nullable=True, server_default=text("'5'")
    )
    updated_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)


# 分红留存窗默认年数（D-4 配置化，2026-09-22 收口）：与 ``DividendYieldSettings.dividend_retention_years``
# 列的 ``server_default='5'`` 一致；配置缺失 / 显式 NULL 时采集窗（retention_cutoff_year）与清理窗
# （retention_cleanup）均回落此值。全局唯一默认值来源，取代原分散的 ``RETAIN_YEARS`` /
# ``_RETENTION_YEARS`` 硬编码常量。
DEFAULT_DIVIDEND_RETENTION_YEARS = 5


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