"""季度股息抓取链路下线（P2 + §4.7 批次）。

- 删除 0004 种子写入的「季度股息抓取」系统任务行（name 唯一约束兜底幂等）。
- PG 不支持 ``ALTER TYPE ... DROP VALUE``，删枚举值须重建类型（单列
  ``job_configs.task_type`` 引用，故先删行 → 列降级 text → DROP TYPE →
  CREATE TYPE（9 值，剔除 DIVIDEND_QUARTERLY_FETCH）→ 列改回枚举）。

Revision ID: 0031_remove_quarterly_dividend_fetch
Revises: 0030_add_dividend_bonus_columns
Create Date: 2026-09-10
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import text

# revision identifiers, used by Alembic.
revision: str = "0031_remove_quarterly_dividend_fetch"
down_revision: str | None = "0030_add_dividend_bonus_columns"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]

# JobTaskType 当前 10 个值，剔除 DIVIDEND_QUARTERLY_FETCH 后为 9 个。
_ENUM_VALUES_KEEP = [
    "MARKET_DATA_SYNC",
    "SECURITY_MASTER_SYNC",
    "HTTP_CALLBACK",
    "ACCOUNT_CLEANUP",
    "LOG_CLEANUP",
    "MARKET_DAILY_CLOSE_FETCH",
    "DIVIDEND_RETENTION_CLEANUP",
    "DIVIDEND_NOTICE_SCAN",
    "TRADE_CALENDAR_REFRESH",
]
_ENUM_VALUES_ALL = _ENUM_VALUES_KEEP + ["DIVIDEND_QUARTERLY_FETCH"]


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
    """删除种子行 + 重建枚举剔除 DIVIDEND_QUARTERLY_FETCH。"""
    # 1) 先删行（避免重建枚举后该行值无对应枚举成员）
    op.execute(
        sa.text("DELETE FROM job_configs WHERE name = '季度股息抓取'")
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
                gen_random_uuid(), '季度股息抓取',
                CAST('DIVIDEND_QUARTERLY_FETCH' AS "JobTaskType"),
                CAST('SYSTEM' AS "JobKind"),
                TRUE, '0 2 28-31 3,6,9,12 *', '{}'::json,
                '每季度最后一天按报告期抓取分红事件（东财主源，夜里 02:00；cron 只表达 28-31，真实季末日由任务内 guard 判定）',
                now(), now()
            WHERE NOT EXISTS (SELECT 1 FROM job_configs WHERE name = '季度股息抓取')
            """
        )
    )
