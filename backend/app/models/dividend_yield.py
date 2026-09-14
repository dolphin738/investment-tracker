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

# --------------------------------------------------------------------------- #
# 历史行情回补模式（迁移 0021 引入）
# --------------------------------------------------------------------------- #
# 回补模式取值。``legacy`` = 原口径：只要该证券存在 ``trade_date <= start_date`` 的日线行
# 就整只跳过（起点覆盖即视为完成），**中间的空洞永不回填**；``gap`` = 严格补洞：按交易日历
# 比对回补窗口，逐个缺失交易日回填；``rebuild`` = 全量重抓：不做覆盖度筛选，对**全部**有分红
# 记录的证券按 ``master_id`` 游标推进重抓整段区间，且为**清空后重建**（写前先删该证券窗口内
# 既有日线，不留旧源/旧复权口径的数据；源给不到的日期宁可空缺），用于统一复权口径等
# 「整体重算」场景——因判据不收敛，靠 ``price_backfill_rebuild_cursor`` 游标才能判定终态。
PRICE_BACKFILL_MODE_LEGACY = "legacy"
PRICE_BACKFILL_MODE_GAP = "gap"
PRICE_BACKFILL_MODE_REBUILD = "rebuild"
PRICE_BACKFILL_MODES: tuple[str, ...] = (
    PRICE_BACKFILL_MODE_LEGACY,
    PRICE_BACKFILL_MODE_GAP,
    PRICE_BACKFILL_MODE_REBUILD,
)

# --------------------------------------------------------------------------- #
# 历史行情回补「复权方式」（迁移 0022 引入）
# --------------------------------------------------------------------------- #
# 回补抓取时传给 akshare ``stock_zh_a_hist`` 的 ``adjust`` 参数。历史口径硬编码不复权
# （``adjust=""``），本配置把它显性化、可控：
# - ``""``（不复权，默认）：原始成交价（含除权跳空），与既有行为**零差异**（存量默认）；
# - ``qfq``（前复权）：保持当前价，历史价随时间变；
# - ``hfq``（后复权）：保持历史价，反映长期真实收益。
PRICE_BACKFILL_ADJUST_NONE = ""  # 不复权（akshare adjust=""）
PRICE_BACKFILL_ADJUST_QFQ = "qfq"  # 前复权
PRICE_BACKFILL_ADJUST_HFQ = "hfq"  # 后复权
PRICE_BACKFILL_ADJUSTS: tuple[str, ...] = (
    PRICE_BACKFILL_ADJUST_NONE,
    PRICE_BACKFILL_ADJUST_QFQ,
    PRICE_BACKFILL_ADJUST_HFQ,
)

# 补洞状态：pending = 待补；exhausted = 已尝试多次仍填不上，不再入批（避免白烧每日额度）。
GAP_STATUS_PENDING = "pending"
GAP_STATUS_EXHAUSTED = "exhausted"
GAP_STATUSES: tuple[str, ...] = (GAP_STATUS_PENDING, GAP_STATUS_EXHAUSTED)


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
    # 每日回补额度（只/天）：把全池回补摊到多天、做成在途任务时，每日「收盘价抓取」
    # 完成后按此额度续跑一批。非空、默认 1000（<=2000 封禁红线，由 PUT 校验约束）。
    price_backfill_quota: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1000, server_default="1000"
    )
    # 在途回补起点日期（"YYYY-MM-DD"）：非空即表示存在在途回补任务，由回补触发/完成流程
    # 服务端管理（POST /backfill-prices 写入、补完清空），PUT 不接受设置以免状态不一致；
    # 全部证券覆盖后由每日批次清空，任务结束、此后不再跑。
    price_backfill_start_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    # 回补起始日期「配置默认值」（YYYY-MM-DD）：与在途标记 price_backfill_start_date 解耦。
    # 用户可在全局设置中保存偏好的回补起点；触发回补（POST /backfill-prices）以本值为起点、
    # 写入在途标记 price_backfill_start_date。本列为纯配置（PUT 可写），不参与在途标记逻辑，
    # 修复「回补起始日期更改后无法保存」——此前该输入框是纯前端本地 ref、不进 PUT，改了等于没存。
    price_backfill_default_start_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    # 当日记账（额度按**自然日**消耗，跨日自动重置）：
    # - last_run_date：最近一次执行回补的自然日；不等于今天则把 used_today 归零；
    # - used_today：今日已处理只数，按「本批实际处理只数」累加（**成败都计**——
    #   数据源抖动时若失败不计，反复重试会把当天额度刷爆）；
    # 同日再次执行只在 remaining = quota - used_today 范围内取批，余额为 0 则当日不再发请求。
    price_backfill_last_run_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    price_backfill_used_today: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    # 最近一次回补失败原因（熔断/接口不可达）：非空表示最近一次在途回补以失败告终，
    # 前端在「在途」旁直接展示；续跑成功 / 补完 / 取消 / 重新触发时清空。
    price_backfill_last_error: Mapped[Optional[str]] = mapped_column(
        String(512), nullable=True
    )
    # 历史行情回补模式：``legacy``（起点覆盖即整只跳过，不补中间空洞，存量默认）或
    # ``gap``（严格补洞：按交易日历比对 [start_date, 昨天] 逐日回填）。
    # 存量行由 server_default='legacy' 覆盖（迁移 0021 无需回填）；值域校验在
    # PUT /settings 与运行时分派（market_daily_price_sync）双重把关。
    price_backfill_mode: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default=PRICE_BACKFILL_MODE_LEGACY,
        server_default=PRICE_BACKFILL_MODE_LEGACY,
    )
    # rebuild（全量重抓）模式的**游标**：上一批重抓完的最后一个 ``master_id``（迁移 0023）。
    # 池按 master_id 升序推进，取不出下一批即池尾 → 终态（清游标 + 清在途标记）。
    # 只有 rebuild 模式使用；由 POST /backfill-prices 重置（新起点 = 新一轮重抓）。
    # 为 NULL = 未开始 / 无进行中的重抓。
    price_backfill_rebuild_cursor: Mapped[Optional[str]] = mapped_column(
        String(36), nullable=True
    )
    # 历史行情回补「复权方式」：``""``（不复权，默认，与既有行为零差异）| ``qfq``（前复权）
    # | ``hfq``（后复权）。回补抓取时作为 akshare ``stock_zh_a_hist`` 的 ``adjust`` 入参，
    # 真正驱动历史回补（此前该参数硬编码为空串）。存量行由 server_default='' 覆盖
    # （迁移 0022 无需回填）；值域校验在 PUT /settings 与运行时分派双重把关。
    price_backfill_adjust: Mapped[str] = mapped_column(
        String(8),
        nullable=False,
        default=PRICE_BACKFILL_ADJUST_NONE,
        server_default=PRICE_BACKFILL_ADJUST_NONE,
    )
    # 交易日历刷新起始日期（YYYY-MM-DD）：全局设置可配，决定 refresh_trade_calendar 的
    # 窗口下限（只落该日及之后的交易日）；None = 用默认下限「去年 1 月 1 日」。
    # 不暴露「结束日期」：akshare tool_trade_date_hist_sina 只给到当年末，配上限也拿不到数据。
    trade_calendar_start_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    updated_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)


class MarketPriceBackfillGap(Base, TimestampMixin):
    """历史行情回补「洞」状态表（严格补洞 gap 模式专用，迁移 0021）。

    为什么需要它：legacy 口径只有「该证券是否存在 ``trade_date <= start_date`` 的日线行」
    一个判据——起点一覆盖就整只永久跳过，**中间的空洞永不回填**（洞即「日历有、日线表无」
    的交易日）。gap 模式改为按交易日历逐日比对，把缺口显式落成一行，待补完即删除。

    - ``(master_id, gap_date)`` 复合唯一 → 重复 sync 幂等，只 INSERT 缺失行；
    - ``status``：``pending`` 待补 / ``exhausted`` 已尝试多次仍填不上（护栏二）；
    - ``attempts``：该洞被纳入批次的次数，达到阈值（``_GAP_MAX_ATTEMPTS``=2）即置
      exhausted 并不再入批——数据源长期没有某日数据时，避免同一批洞每天被重复选中白烧额度；
    - ``last_error``：最近一次尝试的失败原因（可空；成功填上时整行删除，无终态留存）。

    诚实局限：本表只对**起点已覆盖**的证券记洞（完全未覆盖的证券由 legacy 分支兜住，
    否则「N 只 × 窗口交易日」会瞬间撑爆本表）。故单只证券的洞行数上界 = 窗口交易日数。
    """

    __tablename__ = "market_price_backfill_gaps"
    __table_args__ = (
        UniqueConstraint(
            "master_id", "gap_date", name="uq_price_backfill_gap_master_date"
        ),
        # 取批主查询：status + gap_date 前缀，配合窗口上界收窄
        Index("ix_price_backfill_gap_status_date", "status", "gap_date"),
        Index("ix_price_backfill_gap_master", "master_id"),
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
    gap_date: Mapped[date] = mapped_column(Date, nullable=False)
    status: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default=GAP_STATUS_PENDING,
        server_default=GAP_STATUS_PENDING,
    )
    attempts: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, default=0, server_default="0"
    )
    last_error: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)


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