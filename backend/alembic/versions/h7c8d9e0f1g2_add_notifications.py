"""add notifications table (ADR-002 §3 Q2 站内信告警落点)

新增 notifications 表，承接 ``MarketDataSyncService._mark_failure`` 抢占成功后的告警写入。

**迁移红线**：本文件必须接在 g6b7c8d9e0f1（market data priority chain）之后
（down_revision='g6b7c8d9e0f1'），严禁改动任何既有迁移文件，否则断链。
"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "h7c8d9e0f1g2"
down_revision: str | None = "g6b7c8d9e0f1"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_table(
        "notifications",
        sa.Column(
            "id",
            sa.String(length=36),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column(
            "level", sa.String(length=20), nullable=False, server_default="warning"
        ),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("related_type", sa.String(length=40), nullable=True),
        sa.Column("related_id", sa.String(length=36), nullable=True),
        sa.Column("read", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("notifications")
