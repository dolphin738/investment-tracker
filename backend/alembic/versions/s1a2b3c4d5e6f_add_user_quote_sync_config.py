"""用户个性化行情同步配置表 + 移除全局行情同步任务。

背景：把行情自动同步从「管理员全局普通任务 MARKET_DATA_SYNC」改造为
「每个用户自己的配置（按日/周/月周期，只同步自己的组合）」，仍由 APScheduler
统一调度。故：
- 新增 ``user_quote_sync_configs`` 表（每用户一条，upsert）。
- 删除 ``job_configs`` 中已存在的 ``task_type='MARKET_DATA_SYNC'`` 的全局任务行。
  （JobTaskType 枚举值保留，删除 PG 枚举值成本高且现有数据不依赖，不做。）
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "s1a2b3c4d5e6f"
down_revision: str | None = "r6e5f4a3b2c1d"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    # 每用户行情同步配置
    op.create_table(
        "user_quote_sync_configs",
        sa.Column(
            "user_id",
            sa.String(length=36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("frequency", sa.String(length=6), nullable=False, server_default=sa.text("'DAY'")),
        sa.Column("time", sa.String(length=5), nullable=False, server_default=sa.text("'09:00'")),
        sa.Column("weekday", sa.Integer(), nullable=True),
        sa.Column("day_of_month", sa.Integer(), nullable=True),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_status", sa.String(length=10), nullable=True),
        sa.Column("last_message", sa.String(length=512), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    # 移除全局行情同步任务（改造后由每用户配置取代）
    op.execute(sa.text("DELETE FROM job_configs WHERE task_type = 'MARKET_DATA_SYNC'"))


def downgrade() -> None:
    op.drop_table("user_quote_sync_configs")