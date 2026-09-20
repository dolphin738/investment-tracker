"""下线股息主源配置列 ``dividend_report_source_interface_id``（§4.7）。

季度抓取链路（P2 + 0031 下线）是主源列的唯一消费方，链路删除后该列无引用，
随本迁移一并下线。

- upgrade：从 ``dividend_yield_settings`` 删除该列（纯删列，无枚举重建）。
- downgrade：加回该列（FK → quote_provider_interfaces.id，ondelete=SET NULL，可空）。

技术约束：纯删列、无枚举重建，按项目规范走 ``batch_alter_table``（SQLite/PG 双端兼容）。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "0032_drop_dividend_report_source"
down_revision: str | None = "0031_remove_quarterly_dividend_fetch"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]


def upgrade() -> None:
    with op.batch_alter_table("dividend_yield_settings") as batch_op:
        batch_op.drop_column("dividend_report_source_interface_id")


def downgrade() -> None:
    with op.batch_alter_table("dividend_yield_settings") as batch_op:
        batch_op.add_column(
            sa.Column(
                "dividend_report_source_interface_id",
                sa.String(length=36),
                sa.ForeignKey("quote_provider_interfaces.id", ondelete="SET NULL"),
                nullable=True,
            )
        )
