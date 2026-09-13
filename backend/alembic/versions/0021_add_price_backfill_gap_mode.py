"""股息率方案：历史行情回补新增「严格补洞（gap）」模式。

- upgrade：
  1) ``dividend_yield_settings`` 加 ``price_backfill_mode``（非空 VARCHAR(16)，
     server_default ``'legacy'``）。存量行自动取 ``legacy``（原口径：起点覆盖即整只跳过、
     不补中间空洞），故无需回填、行为零变化；``gap`` = 严格补洞（按交易日历逐日回填）。
  2) 建表 ``market_price_backfill_gaps``：记录「日历有、日线表无」的缺失交易日
     （复合唯一 ``(master_id, gap_date)``），带 ``status`` / ``attempts`` / ``last_error``
     供「尝试 N 次仍填不上即 exhausted」护栏使用。
- 接续 0020（纯增量：列 + 新表）；downgrade 完整反向（drop_table + drop_column），可往返。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "0021_add_price_backfill_gap_mode"
down_revision: str | None = "0020_add_trade_calendar_start_date"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]


def upgrade() -> None:
    op.add_column(
        "dividend_yield_settings",
        sa.Column(
            "price_backfill_mode",
            sa.String(16),
            nullable=False,
            server_default="legacy",
        ),
    )
    op.create_table(
        "market_price_backfill_gaps",
        # 主键与全仓一致：DB 端 gen_random_uuid()（见 app/db/base.py pk_uuid）
        sa.Column(
            "id", sa.String(36), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("master_id", sa.String(36), nullable=False),
        sa.Column("gap_date", sa.Date(), nullable=False),
        sa.Column(
            "status", sa.String(16), nullable=False, server_default="pending"
        ),
        sa.Column("attempts", sa.SmallInteger(), nullable=False, server_default="0"),
        sa.Column("last_error", sa.String(512), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["master_id"],
            ["securities.id"],
            ondelete="CASCADE",
            deferrable=True,
            initially="DEFERRED",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "master_id", "gap_date", name="uq_price_backfill_gap_master_date"
        ),
    )
    op.create_index(
        "ix_price_backfill_gap_status_date",
        "market_price_backfill_gaps",
        ["status", "gap_date"],
    )
    op.create_index(
        "ix_price_backfill_gap_master",
        "market_price_backfill_gaps",
        ["master_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_price_backfill_gap_master", table_name="market_price_backfill_gaps"
    )
    op.drop_index(
        "ix_price_backfill_gap_status_date", table_name="market_price_backfill_gaps"
    )
    op.drop_table("market_price_backfill_gaps")
    op.drop_column("dividend_yield_settings", "price_backfill_mode")
