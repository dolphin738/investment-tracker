"""股息率方案：``dividend_yield_settings`` 新增回补额度与在途回补起点配置列。

- upgrade：加两列
  - ``price_backfill_quota``：每日回补额度（只/天），``Integer``，非空，默认 1000；
  - ``price_backfill_start_date``：在途回补起点日期（"YYYY-MM-DD"），``Date``，可空；
    非空即表示存在在途回补任务（由回补触发/完成流程服务端管理，PUT 不接受设置）。
- 与 0013 同构（纯增量列）；``price_backfill_quota`` 用 ``server_default="1000"`` 保证
  既有行与新建行都有兜底额度，避免每日批次读取到 NULL 后无默认值。
- downgrade：仅 drop 两列（纯增量列，可往返）。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "0014_add_price_backfill_quota"
down_revision: str | None = "0013_add_price_backfill_source"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]


def upgrade() -> None:
    op.add_column(
        "dividend_yield_settings",
        sa.Column(
            "price_backfill_quota",
            sa.Integer(),
            nullable=False,
            server_default="1000",
        ),
    )
    op.add_column(
        "dividend_yield_settings",
        sa.Column("price_backfill_start_date", sa.Date(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("dividend_yield_settings", "price_backfill_start_date")
    op.drop_column("dividend_yield_settings", "price_backfill_quota")
