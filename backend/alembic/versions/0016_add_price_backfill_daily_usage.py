"""历史行情回补：新增「当日已用额度」记账列（额度按自然日消耗）。

背景（口径修正）：
- ``price_backfill_quota`` 语义是**每天**固定额度，任何方式/原因触发的执行都消耗它，
  当天再次执行只能在**剩余额度**范围内跑；
- 但此前实现只在 ``_select_pending_backfill_masters`` 处 ``limit(quota)``，
  **没有跨日概念、也没有当日记账**，导致「手动触发当天 + 当日收盘价抓取续跑」
  会跑掉 2 × quota，且同日反复触发都能跑满额度——与「额度是每天的」直接冲突。

本迁移新增两列供当日记账：
- ``price_backfill_last_run_date``：最近一次执行的自然日（跨日则重置计数）；
- ``price_backfill_used_today``：今日已处理只数（按本批实际处理只数累加，成败都计）。

依赖：紧随 0015 之后（0015 目前为工作树未提交改动，须与其一并提交，
否则迁移链会断）。

Revision ID: 0016_add_price_backfill_daily_usage
Revises: 0015_remove_special_backfill_task
"""
from alembic import op
import sqlalchemy as sa

revision: str = "0016_add_price_backfill_daily_usage"
down_revision: str | None = "0015_remove_special_backfill_task"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]


def upgrade() -> None:
    op.add_column(
        "dividend_yield_settings",
        sa.Column("price_backfill_last_run_date", sa.Date(), nullable=True),
    )
    op.add_column(
        "dividend_yield_settings",
        sa.Column(
            "price_backfill_used_today",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )


def downgrade() -> None:
    op.drop_column("dividend_yield_settings", "price_backfill_used_today")
    op.drop_column("dividend_yield_settings", "price_backfill_last_run_date")
