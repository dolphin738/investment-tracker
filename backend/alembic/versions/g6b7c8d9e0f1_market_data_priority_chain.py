"""market data priority chain (ADR-002 方案 X)

分类级接口优先级链 + 顺序 fallback + 连续失败告警 + 数据时效字段：

- quote_provider_interfaces：+priority / +consecutive_failures / +alerted /
  +resp_code_field / +resp_price_field
- securities_data_providers：-is_default / -is_active（全局单一活跃源完全移除，
  提供方仅保留 enabled 开关）
- security_prices：+fetched_at / +source

**迁移红线**：本文件必须接在链头 f5a6b7c8d9e0 之后（down_revision='f5a6b7c8d9e0'），
严禁改动任何既有迁移文件，否则断链。
"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "g6b7c8d9e0f1"
down_revision: str | None = "f5a6b7c8d9e0"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    # 1) quote_provider_interfaces 新增 5 列
    op.add_column(
        "quote_provider_interfaces",
        sa.Column("priority", sa.Integer(), nullable=True),
    )
    op.create_index(
        "ix_quote_provider_interfaces_priority",
        "quote_provider_interfaces",
        ["priority"],
        unique=False,
    )
    op.add_column(
        "quote_provider_interfaces",
        sa.Column(
            "consecutive_failures",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "quote_provider_interfaces",
        sa.Column(
            "alerted",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "quote_provider_interfaces",
        sa.Column(
            "resp_code_field",
            sa.String(length=64),
            nullable=False,
            server_default="code",
        ),
    )
    op.add_column(
        "quote_provider_interfaces",
        sa.Column(
            "resp_price_field",
            sa.String(length=64),
            nullable=False,
            server_default="price",
        ),
    )

    # 2) securities_data_providers 移除全局活跃源两列
    op.drop_column("securities_data_providers", "is_default")
    op.drop_column("securities_data_providers", "is_active")

    # 3) security_prices 新增数据时效字段
    op.add_column(
        "security_prices",
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "security_prices",
        sa.Column("source", sa.String(length=64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("security_prices", "source")
    op.drop_column("security_prices", "fetched_at")

    op.add_column(
        "securities_data_providers",
        sa.Column(
            "is_active",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "securities_data_providers",
        sa.Column(
            "is_default",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )

    op.drop_column("quote_provider_interfaces", "resp_price_field")
    op.drop_column("quote_provider_interfaces", "resp_code_field")
    op.drop_column("quote_provider_interfaces", "alerted")
    op.drop_column("quote_provider_interfaces", "consecutive_failures")
    op.drop_index(
        "ix_quote_provider_interfaces_priority",
        table_name="quote_provider_interfaces",
    )
    op.drop_column("quote_provider_interfaces", "priority")
