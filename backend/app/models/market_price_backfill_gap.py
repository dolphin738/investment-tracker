"""历史行情回补「洞」状态模型（严格补洞 gap 模式专用，迁移 0021）。

自 ``dividend_yield`` 抽出（《架构治理规范》§4：存量超限文件禁止继续增长），使
``dividend_yield`` 只承载股息率相关表；本模块只承载 ``market_price_backfill_gaps``
一张表及其状态常量。
"""
from __future__ import annotations

from datetime import date
from typing import Optional

from sqlalchemy import (
    Date,
    ForeignKey,
    Index,
    SmallInteger,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, pk_uuid

# 补洞状态：pending = 待补；exhausted = 已尝试多次仍填不上，不再入批（避免白烧每日额度）。
GAP_STATUS_PENDING = "pending"
GAP_STATUS_EXHAUSTED = "exhausted"
GAP_STATUSES: tuple[str, ...] = (GAP_STATUS_PENDING, GAP_STATUS_EXHAUSTED)


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
