"""股息率全量重建：移出系统定时任务（改由排名页手动按钮触发）。

- 删除 0004 种子写入的「股息率全量重建」系统任务行（name 唯一约束兜底幂等）。
- PG 不支持 ``ALTER TYPE ... DROP VALUE``，删枚举值须重建类型（单列
  ``job_configs.task_type`` 引用，故先删行 → 列降级 text → DROP TYPE →
  CREATE TYPE（9 值，剔除 DIVIDEND_YIELD_REBUILD）→ 列改回枚举）。

Revision ID: 0008_remove_dividend_yield_rebuild_task
Revises: 0007_announcement_source_seed
Create Date: 2026-09-07
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import text

# revision identifiers, used by Alembic.
revision: str = "0008_remove_dividend_yield_rebuild_task"
down_revision: str | None = "0007_announcement_source_seed"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]

# op.execute() 只接受单条 SQL（项目既有约束），全部分条执行。
# JobTaskType 当前 10 个值，剔除 DIVIDEND_YIELD_REBUILD 后为 9 个。
_ENUM_VALUES_KEEP = [
    "MARKET_DATA_SYNC",
    "SECURITY_MASTER_SYNC",
    "HTTP_CALLBACK",
    "ACCOUNT_CLEANUP",
    "LOG_CLEANUP",
    "DIVIDEND_QUARTERLY_FETCH",
    "MARKET_DAILY_CLOSE_FETCH",
    "DIVIDEND_RETENTION_CLEANUP",
    "DIVIDEND_NOTICE_SCAN",
]
_ENUM_VALUES_ALL = _ENUM_VALUES_KEEP + ["DIVIDEND_YIELD_REBUILD"]


def _rebuild_enum(values: list[str]) -> None:
    """单列 job_configs.task_type 引用 JobTaskType：列降级 text → 重建类型 → 列改回。"""
    enum_sql = ", ".join(f"'{v}'" for v in values)
    op.execute(
        sa.text('ALTER TABLE job_configs ALTER COLUMN task_type TYPE text USING task_type::text')
    )
    op.execute(sa.text('DROP TYPE "JobTaskType"'))
    op.execute(sa.text(f'CREATE TYPE "JobTaskType" AS ENUM({enum_sql})'))
    op.execute(
        sa.text(
            'ALTER TABLE job_configs ALTER COLUMN task_type TYPE "JobTaskType" '
            'USING task_type::text::"JobTaskType"'
        )
    )


def upgrade() -> None:
    """删除种子行 + 重建枚举剔除 DIVIDEND_YIELD_REBUILD。"""
    # 1) 先删行（避免重建枚举后该行值无对应枚举成员）
    op.execute(
        sa.text("DELETE FROM job_configs WHERE name = '股息率全量重建'")
    )
    # 2) 重建枚举（单列引用，安全）
    _rebuild_enum(_ENUM_VALUES_KEEP)


def downgrade() -> None:
    """重建枚举加回值 + 重新插入种子行（默认禁用）。"""
    _rebuild_enum(_ENUM_VALUES_ALL)
    op.execute(
        sa.text(
            """
            INSERT INTO job_configs
                (id, name, task_type, kind, enabled, cron_expr, params, description, created_at, updated_at)
            SELECT
                gen_random_uuid(), '股息率全量重建',
                CAST('DIVIDEND_YIELD_REBUILD' AS "JobTaskType"),
                CAST('SYSTEM' AS "JobKind"),
                FALSE, '0 4 * * *', '{}'::json,
                '全量重建派生快照（默认禁用，仅迁移后建基线或 admin 手动 trigger 时执行）',
                now(), now()
            WHERE NOT EXISTS (SELECT 1 FROM job_configs WHERE name = '股息率全量重建')
            """
        )
    )
