"""SecurityType 枚举调整：新增 LOF、停用 CASH (资产类型体系收窄).

Revises: i8d9e0f1g2h3
- ALTER TYPE SecurityType ADD VALUE 'LOF'（PG 要求 ADD VALUE 在事务块外，用 autocommit_block）。
- CASH 枚举值**保留在数据库**：asyncpg 扩展查询协议不支持 `ALTER TYPE ... DROP VALUE`
  （PG 16 实测语法错误），故无法在迁移中删除枚举值；代码层面已移除 CASH，
  不再产生/读取该值，历史遗留的 CASH 值不影响功能。

Create Date: 2026-08-14
"""
from collections.abc import Sequence

from alembic import op
from sqlalchemy.sql import text

# revision identifiers, used by Alembic.
revision: str = "j9e0f1a2b3c4"
down_revision: str | None = "i8d9e0f1g2h3"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    # ADD VALUE 不能在事务块内执行，用 autocommit_block 隔离执行
    ctx = op.get_context()
    with ctx.autocommit_block():
        op.execute(text("ALTER TYPE \"SecurityType\" ADD VALUE IF NOT EXISTS 'LOF'"))


def downgrade() -> None:
    # 回退：无法删除已 ADD 的 LOF（asyncpg 不支持 DROP VALUE），且需先转换数据；
    # 此处保留 LOF 值（无害），仅记录说明。
    pass