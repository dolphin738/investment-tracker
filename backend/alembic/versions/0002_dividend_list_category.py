"""新增接口分类：股息列表

在「接口分类管理」中新增系统内置分类「股息列表」（system=True，不可删除、
不可创建同名），与「证券列表」「证券行情」两个固定分类同形态，
供把证券行情接口归类到股息列表。

新增方式为幂等 seed：仅当不存在同名的系统分类时才插入，重复执行安全；
downgrade 仅删除本次新增的固定 id 分类。

Revision ID: 0002_dividend_list_category
Revises: squashed_0001_initial
Create Date: 2026-08-30
"""
from alembic import op
from sqlalchemy import text

# revision identifiers, used by Alembic.
revision: str = "0002_dividend_list_category"
down_revision: str | None = "squashed_0001_initial"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]

# 固定 id（与 0001 中证券列表=1、证券行情=2 连续递增，便于 downgrade 精确定位）
DIVIDEND_LIST_CAT_ID = "3"


def upgrade() -> None:
    """插入系统内置分类「股息列表」（幂等）。"""
    op.execute(
        text(
            "INSERT INTO quote_provider_interface_categories "
            "(id, label, icon, sort_order, system, created_at, updated_at) "
            "SELECT :id, '股息列表', 'HandCoins', 3, TRUE, now(), now() "
            "WHERE NOT EXISTS ("
            "  SELECT 1 FROM quote_provider_interface_categories "
            "  WHERE system AND label = '股息列表'"
            ")"
        ).bindparams(id=DIVIDEND_LIST_CAT_ID)
    )


def downgrade() -> None:
    """移除本次新增的系统内置分类。"""
    op.execute(
        text(
            "DELETE FROM quote_provider_interface_categories "
            "WHERE id = :id AND system"
        ).bindparams(id=DIVIDEND_LIST_CAT_ID)
    )