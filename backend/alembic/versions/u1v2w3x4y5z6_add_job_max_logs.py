"""任务表新增 max_logs：控制单个任务执行日志的保留条数上限。

背景：job_run_logs 只写不删，长期运行会无限累积。为控制日志规模，在 job_configs
增加可空列 max_logs：
- NULL 或 <=0：不限制（保持既有行为）
- 正整数：每次执行落库后，该任务按开始时间倒序保留最新 max_logs 条，删除更旧的
具体裁剪逻辑在 app/core/scheduler.py 的 _prune_run_logs。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "u1v2w3x4y5z6"
down_revision: str | None = "t0u1v2w3x4y5"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column("job_configs", sa.Column("max_logs", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("job_configs", "max_logs")