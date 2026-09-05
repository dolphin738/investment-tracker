"""接口分类外键改为 ON DELETE RESTRICT

新规则要求「分类下已配置接口则禁止删除」：外键从 ON DELETE SET NULL 改为
ON DELETE RESTRICT，让数据库成为「有子记录则拒绝删除」的权威防线，与应用层
400 友好前置互补（消除 SET NULL 与新规则语义矛盾 + 检查-删除之间的 TOCTOU 窗口）。

注意：0001 为 squashed 初始迁移（历史库已按其 stamp），此处走新增迁移改 FK，
0001 定义保持不动，保证与历史库 alembic_version 同步。

Revision ID: 0003_interface_category_fk
Revises: 0002_dividend_list_category
Create Date: 2026-09-05

revision id 控制在 32 字符内（alembic_version.version_num 为 varchar(32)）。
"""
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0003_interface_category_fk"
down_revision: str | None = "0002_dividend_list_category"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]

_FK_NAME = "fk_quote_provider_interfaces_category_id"
_TABLE = "quote_provider_interfaces"
_REFTABLE = "quote_provider_interface_categories"


def upgrade() -> None:
    """重建外键为 ON DELETE RESTRICT（先删后建同名约束）。"""
    op.drop_constraint(_FK_NAME, _TABLE, type_="foreignkey")
    op.create_foreign_key(
        _FK_NAME,
        _TABLE,
        _REFTABLE,
        ["category_id"],
        ["id"],
        ondelete="RESTRICT",
    )


def downgrade() -> None:
    """回退外键为 ON DELETE SET NULL。"""
    op.drop_constraint(_FK_NAME, _TABLE, type_="foreignkey")
    op.create_foreign_key(
        _FK_NAME,
        _TABLE,
        _REFTABLE,
        ["category_id"],
        ["id"],
        ondelete="SET NULL",
    )