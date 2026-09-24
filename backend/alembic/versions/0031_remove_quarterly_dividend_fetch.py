"""季度股息抓取链路下线（P2 + §4.7 批次）。

- 删除 0004 种子写入的「季度股息抓取」系统任务行（name 唯一约束兜底幂等）。
- PG 不支持 ``ALTER TYPE ... DROP VALUE``，删枚举值须重建类型（单列
  ``job_configs.task_type`` 引用，故先删行 → 列降级 text → DROP TYPE →
  CREATE TYPE（9 值，剔除 DIVIDEND_QUARTERLY_FETCH）→ 列改回枚举）。
- ``downgrade`` 还原目标 ``_ENUM_VALUES_ALL`` 必须是**全历史 11 值**（9 + ``DIVIDEND_SPECIAL_BACKFILL`` + ``DIVIDEND_QUARTERLY_FETCH``）：降级到 0015 以下时
  ``0015.downgrade`` 有 ``CAST('DIVIDEND_SPECIAL_BACKFILL' AS "JobTaskType")``，枚举缺该值
  会导致**反向迁移链在 0015 处断链**。
- 重建前先删除「引用不在目标保留列表里的 task_type」的 job_configs 行：否则
  ``ALTER COLUMN ... USING task_type::text::"JobTaskType"`` 会因该行值无对应枚举成员而
  转换失败（与 ``name`` 删除互补——后者只覆盖已知种子行）。

Revision ID: 0031_remove_quarterly_dividend_fetch
Revises: 0030_add_dividend_bonus_columns
Create Date: 2026-09-10
"""
import logging

from alembic import op
import sqlalchemy as sa
from sqlalchemy import text

logger = logging.getLogger("alembic.runtime.migration")

# revision identifiers, used by Alembic.
revision: str = "0031_remove_quarterly_dividend_fetch"
down_revision: str | None = "0030_add_dividend_bonus_columns"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]

# JobTaskType 当前 11 个值（9 基础 + DIVIDEND_SPECIAL_BACKFILL(0011) + DIVIDEND_QUARTERLY_FETCH）。
# _ENUM_VALUES_KEEP 是 upgrade 目标：剔除 DIVIDEND_QUARTERLY_FETCH，保留 9 个
# （DIVIDEND_SPECIAL_BACKFILL 在 P1 已随旧回补链路删除，故不在保留集）。
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
# downgrade 目标：还原全历史 11 值。**必须含 DIVIDEND_SPECIAL_BACKFILL** —— 否则降级
# 到 0015 以下时 0015.downgrade 的 CAST('DIVIDEND_SPECIAL_BACKFILL' AS "JobTaskType")
# 会因枚举缺该值而断链（本迁移修复的核心缺陷）。
_ENUM_VALUES_ALL = _ENUM_VALUES_KEEP + [
    "DIVIDEND_SPECIAL_BACKFILL",
    "DIVIDEND_QUARTERLY_FETCH",
]


def _rebuild_enum(values: list[str]) -> None:
    """单列 job_configs.task_type 引用 JobTaskType：列降级 text → 重建类型 → 列改回。"""
    # 先删除引用「不在目标保留列表」里的 task_type 的行：否则列改回枚举时
    # USING task_type::text::"JobTaskType" 会因该行值无对应枚举成员而转换失败
    # （name 删除只覆盖已知种子行，无法防普通任务行引用被删枚举值）。
    quoted = ", ".join(f"'{v}'" for v in values)
    # S23 留痕：这是**宽面** DELETE（按 task_type 值集合删，不是按 name 删种子行）——
    # 静默删除事后无法对账，故记一行 INFO（行数 + 目标保留集）。rowcount 用 getattr
    # 容错：护栏测试只 monkeypatch ``op.execute``（返回 None），真实迁移里才是
    # CursorResult；日志路径不得反向绑架 DDL 的可测试性。
    deleted = getattr(
        op.execute(
            sa.text(f"DELETE FROM job_configs WHERE task_type::text NOT IN ({quoted})")
        ),
        "rowcount",
        None,
    )
    logger.info(
        "0031：重建枚举前清理 job_configs %s 行（保留 task_type=%s）", deleted, values
    )
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
    # 1) 先删行（避免重建枚举后该行值无对应枚举成员）；S23：留一行日志便于事后对账
    deleted = getattr(
        op.execute(sa.text("DELETE FROM job_configs WHERE name = '季度股息抓取'")),
        "rowcount",
        None,
    )
    logger.info("0031：删除种子行「季度股息抓取」%s 行", deleted)
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
                FALSE, '0 2 28-31 3,6,9,12 *', '{}'::json,
                '每季度最后一天按报告期抓取分红事件（东财主源，夜里 02:00；cron 只表达 28-31，真实季末日由任务内 guard 判定）',
                now(), now()
            WHERE NOT EXISTS (SELECT 1 FROM job_configs WHERE name = '季度股息抓取')
            """
        )
    )
