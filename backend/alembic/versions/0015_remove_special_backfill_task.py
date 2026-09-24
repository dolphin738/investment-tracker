"""删除「特别分红历史回补」系统任务（§6.9，功能已由全局设置页按钮取代）。

- 按钮版 ``/api/dividend-yield/backfill-specials`` 已改为直接 fire-and-forget 调
  ``run_dividend_special_backfill(None)``，不再依赖本系统任务，故删除迁移 0011 种子写入的任务行。
- PG 原生枚举 ``JobTaskType`` 的 ``'DIVIDEND_SPECIAL_BACKFILL'`` 值**保留不回收**
  （PG 不支持 DROP VALUE，且已无行引用，残留值不影响运行，同 0011 downgrade 口径）。
- 位置：紧随 0012 之后（0013/0014 已物理删除，链上实际前驱是 0012；
  本 docstring 曾写 Revises 0014 与 ``down_revision`` 不符，§4 已纠正）。

Revision ID: 0015_remove_special_backfill_task
Revises: 0012_add_response_fields
"""
from alembic import op
import sqlalchemy as sa

revision: str = "0015_remove_special_backfill_task"
down_revision: str | None = "0012_add_response_fields"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]


def upgrade() -> None:
    op.execute(
        sa.text("DELETE FROM job_configs WHERE name = '特别分红历史回补'")
    )


def downgrade() -> None:
    # 还原 0011 同构的种子系统任务（enabled=FALSE：不自动调度，仅手动 trigger）
    op.execute(
        sa.text(
            """
            INSERT INTO job_configs
                (id, name, task_type, kind, enabled, cron_expr, params, description,
                 created_at, updated_at)
            SELECT
                gen_random_uuid(), '特别分红历史回补',
                CAST('DIVIDEND_SPECIAL_BACKFILL' AS "JobTaskType"),
                CAST('SYSTEM' AS "JobKind"),
                FALSE, '0 3 1 1 *', '{}'::json,
                '冷启动一次性：回溯新浪历史明细补齐 5 年特别分红（§6.9）。默认禁用、仅手动 trigger；'
                '须在季度股息抓取之后执行，否则普通分红会被误判为特别分红导致分子重复计数',
                now(), now()
            WHERE NOT EXISTS (SELECT 1 FROM job_configs WHERE name = '特别分红历史回补')
            """
        )
    )
