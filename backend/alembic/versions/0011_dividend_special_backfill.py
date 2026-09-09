"""特别分红历史回补：新增系统任务（§6.9，冷启动一次性手动 trigger）。

- 原生枚举 ``JobTaskType`` 扩展 ``'DIVIDEND_SPECIAL_BACKFILL'``——PG 要求
  ``ALTER TYPE ADD VALUE`` 在事务块外执行，故用 ``autocommit_block`` 隔离
  （同 0001 对 ``LOG_CLEANUP`` 的处理）。
- 种子写入系统任务行：``kind=SYSTEM``、``enabled=FALSE``——**不按 cron 自动调度**，
  仅供冷启动手动 trigger，避免周期性误跑；``name`` 唯一约束 + ``WHERE NOT EXISTS`` 兜底幂等。
- 顺序硬依赖见 §6.9：本任务**必须在季度股息抓取之后**执行，否则普通分红会被误判为
  「东财缺失」而全部落 SPECIAL，导致分子重复计数。

Revision ID: 0011_dividend_special_backfill
Revises: 0010_dividend_nan_cleanup
"""
from alembic import op
import sqlalchemy as sa

revision: str = "0011_dividend_special_backfill"
down_revision: str | None = "0010_dividend_nan_cleanup"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]


def upgrade() -> None:
    # 1) 扩展原生枚举（ADD VALUE 须在 autocommit 块内执行，隔离独立事务）
    with op.get_context().autocommit_block():
        op.execute(
            sa.text(
                'ALTER TYPE "JobTaskType" ADD VALUE IF NOT EXISTS '
                "'DIVIDEND_SPECIAL_BACKFILL'"
            )
        )
    # 2) 种子系统任务行（enabled=FALSE：不自动调度，仅手动 trigger）
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


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM job_configs WHERE name = '特别分红历史回补'"))
    # 枚举值不回收：PG 不支持 DROP VALUE，保留该值不影响运行（无行引用）。
