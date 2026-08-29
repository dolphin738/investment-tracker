"""新增 users.token_version 支持 JWT 吊销（REP-011）。

- 改密 / 改邮箱 / 恢复账户时，User.token_version 自增；
- get_current_user 校验 token 携带的 tv 与库内一致，不一致即视为失效（需重登）。
- 存量用户默认 0，旧 token 无 tv 声明按 0 处理，不强制存量用户下线。

接在 w3x4y5z6a7b8 之后（down_revision='w3x4y5z6a7b8'），严禁改动既有迁移文件，否则断链。
"""
from __future__ import annotations

from alembic import op
from sqlalchemy import text


# revision identifiers, used by Alembic.
revision: str = "x4y5z6a7b8c9"
down_revision: str | None = "w3x4y5z6a7b8"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    # 漂移态守卫：IF NOT EXISTS 使迁移幂等（全新库照常加列，漂移库无操作）。
    # 语义对齐原 sa.Column(Integer, nullable=False, server_default=sa.text("0"))；
    # 存量用户行由 DEFAULT 0 填充，不会违反 NOT NULL。
    op.execute(
        text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS "
            "token_version INTEGER NOT NULL DEFAULT 0"
        )
    )


def downgrade() -> None:
    # 与 upgrade 对称使用 IF EXISTS，容忍「列已不存在」的漂移库，保证降级不中断。
    op.execute(text("ALTER TABLE users DROP COLUMN IF EXISTS token_version"))
