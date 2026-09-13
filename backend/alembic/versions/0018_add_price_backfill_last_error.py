"""股息率方案：``dividend_yield_settings`` 新增回补失败原因列。

- upgrade：加 ``price_backfill_last_error``（可空 VARCHAR(512)），由回补熔断/接口异常
  时回写，供前端在「在途」旁展示失败原因（设计内熔断不再对前端与日志中心双盲）。
- 接续 0017（纯增量列）；revision 字符串 31 字符，未超 ``alembic_version.version_num``
  既有的 VARCHAR(64) 上限，upgrade 无需再扩列。
- downgrade：仅 drop 该列（纯增量列，可往返）。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "0018_add_price_backfill_last_error"
down_revision: str | None = "0017_add_price_backfill_default_start_date"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]


def upgrade() -> None:
    op.add_column(
        "dividend_yield_settings",
        sa.Column("price_backfill_last_error", sa.String(512), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("dividend_yield_settings", "price_backfill_last_error")
