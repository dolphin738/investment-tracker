"""任务表新增 max_logs：控制单个任务执行日志的保留条数上限。

背景：job_run_logs 只写不删，长期运行会无限累积。为控制日志规模，在 job_configs
增加可空列 max_logs：
- NULL 或 <=0：不限制（保持既有行为）
- 正整数：每次执行落库后，该任务按开始时间倒序保留最新 max_logs 条，删除更旧的
具体裁剪逻辑在 app/core/scheduler.py 的 _prune_run_logs。
"""
from __future__ import annotations

from alembic import op
from sqlalchemy import text

# revision identifiers, used by Alembic.
revision: str = "u1v2w3x4y5z6"
down_revision: str | None = "t7u8v9w0x1y2"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    # 漂移态守卫：开发库可能经 create_all 建表 + stamp 打戳，列已存在；
    # IF NOT EXISTS 使迁移幂等（全新库照常加列，漂移库无操作）。
    op.execute(text("ALTER TABLE job_configs ADD COLUMN IF NOT EXISTS max_logs INTEGER"))


def downgrade() -> None:
    # 与 upgrade 对称使用 IF EXISTS，容忍「列已不存在」的漂移库，保证降级不中断。
    op.execute(text("ALTER TABLE job_configs DROP COLUMN IF EXISTS max_logs"))