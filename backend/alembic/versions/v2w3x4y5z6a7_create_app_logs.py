"""新增统一日志表 app_logs（方案 §4.1）。

承接全站运行错误 / 业务操作日志的持久化。仅建单表，无原生枚举（level/scope 用
VARCHAR + 应用层约束），故迁移零类型创建；幂等守卫用 CREATE TABLE IF NOT EXISTS，
可安全重复执行（不会因表已存在而报错）。

接在 u1v2w3x4y5z6 之后（down_revision='u1v2w3x4y5z6'），严禁改动既有迁移文件，否则断链。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# 导入模型确保注册到 Base.metadata（供 autogenerate 比对）
from app.models.log import AppLog  # noqa: F401


# revision identifiers, used by Alembic.
revision: str = "v2w3x4y5z6a7"
down_revision: str | None = "u1v2w3x4y5z6"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.execute(
        sa.text(
            """
            CREATE TABLE IF NOT EXISTS app_logs (
                id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
                level VARCHAR(20) NOT NULL DEFAULT 'info',
                scope VARCHAR(20) NOT NULL DEFAULT 'operation',
                module VARCHAR(64) NOT NULL,
                message TEXT NOT NULL,
                trace TEXT,
                detail JSON,
                user_id VARCHAR(36),
                created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
            )
            """
        )
    )


def downgrade() -> None:
    op.execute(sa.text("DROP TABLE IF EXISTS app_logs"))
