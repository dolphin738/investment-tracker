"""股息率方案：历史行情回补新增「复权方式」（adjust）配置项。

- upgrade：``dividend_yield_settings`` 加 ``price_backfill_adjust``（非空 VARCHAR(8)，
  server_default ``''``）。存量行自动取 ``''``（不复权，与原硬编码 ``adjust=""`` 行为
  **零差异**），故无需回填、行为零变化；``qfq`` = 前复权、``hfq`` = 后复权。
- 接续 0021（纯增量：单列）；downgrade 完整反向（drop_column），可往返。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "0022_add_price_backfill_adjust"
down_revision: str | None = "0021_add_price_backfill_gap_mode"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]


def upgrade() -> None:
    op.add_column(
        "dividend_yield_settings",
        sa.Column(
            "price_backfill_adjust",
            sa.String(8),
            nullable=False,
            server_default="",
        ),
    )


def downgrade() -> None:
    op.drop_column("dividend_yield_settings", "price_backfill_adjust")
