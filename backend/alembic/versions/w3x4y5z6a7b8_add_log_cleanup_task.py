"""新增 LOG_CLEANUP 系统任务（方案 §4.6）。

- 原生枚举 JobTaskType 扩展 'LOG_CLEANUP'（PG12+ 允许事务内 ADD VALUE，参考
  p4f7a8b9c0d1_asset_class_multiselect 写法；枚举类型名带大写须加引号）。
- 种子写入系统 JobConfig（镜像 r6e5f4a3b2c1d 的 ACCOUNT_CLEANUP 播种：
  名称唯一约束兜底幂等，参数填默认按级别策略）。

接在 v2w3x4y5z6a7 之后（down_revision='v2w3x4y5z6a7'），严禁改动既有迁移文件，否则断链。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text


# revision identifiers, used by Alembic.
revision: str = "w3x4y5z6a7b8"
down_revision: str | None = "v2w3x4y5z6a7"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    # 1) 扩展原生枚举（事务内 ADD VALUE，IF NOT EXISTS 幂等）
    op.execute(
        text("ALTER TYPE \"JobTaskType\" ADD VALUE IF NOT EXISTS 'LOG_CLEANUP'")
    )

    # 2) 种子：系统任务（名称唯一约束兜底，勿重复执行）
    op.execute(
        sa.text(
            """
            INSERT INTO job_configs
                (id, name, task_type, kind, enabled, cron_expr, params, description, created_at, updated_at)
            SELECT
                gen_random_uuid(), '日志中心清理',
                CAST('LOG_CLEANUP' AS "JobTaskType"),
                CAST('SYSTEM' AS "JobKind"),
                true, '0 3 * * *',
                '{"retention_days": {"error": 90, "warning": 30, "info": 7}, '
                '"max_rows": {"error": 20000, "warning": 10000, "info": 5000}, '
                '"notifications_retention_days": 30}'::json,
                '按级别分级清理日志中心：app_logs 过期/超量、已读且超期通知、'
                '未配置 max_logs 的任务日志。系统任务仅可编辑不可删。',
                now(), now()
            WHERE NOT EXISTS (SELECT 1 FROM job_configs WHERE name = '日志中心清理')
            """
        )
    )


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM job_configs WHERE name = '日志中心清理'"))
    # 枚举值 PG 不可事务内移除，且其他数据可能已引用，故不 DROP VALUE（与既有迁移一致）。
