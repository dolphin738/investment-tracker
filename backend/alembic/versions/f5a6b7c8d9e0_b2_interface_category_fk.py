"""B2 + 选项 ii：接口分类改纯外键 + 移除分类 key 列

将 quote_provider_interfaces 的「分类」由自由文本 interface_type 改为外键
category_id → quote_provider_interface_categories.id（ON DELETE SET NULL），
并删除接口分类表的 key 列（含其 UNIQUE 约束）。

- upgrade：
  ① 新增 category_id 列 + 外键 + 索引；
  ② backfill：把旧 interface_type（分类 key）回填成匹配分类的 id；
     匹配不上（自定义/脏数据）→ NULL（即「未分类」）；
  ③ 删除旧 interface_type 列；
  ④ 删除分类表 key 列（其 UNIQUE 约束随列删除由 PostgreSQL 自动移除）。
- downgrade：反向重建，并把 category_id 写回 interface_type（按 id 反查 key）。

链：接在 e4f5a6b7c8d9 之后。
Revision ID: f5a6b7c8d9e0
Revises: e4f5a6b7c8d9
Create Date: 2026-08-13 03:00:00.000000
"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "f5a6b7c8d9e0"
down_revision: str | None = "e4f5a6b7c8d9"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    # ① 新增 category_id 列 + 外键 + 索引
    op.add_column(
        "quote_provider_interfaces",
        sa.Column("category_id", sa.String(length=36), nullable=True),
    )
    op.create_foreign_key(
        "fk_quote_provider_interfaces_category_id",
        "quote_provider_interfaces",
        "quote_provider_interface_categories",
        ["category_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_quote_provider_interfaces_category_id",
        "quote_provider_interfaces",
        ["category_id"],
    )

    # ② backfill：旧 interface_type（分类 key）回填成匹配分类的 id；
    # 匹配不上（自定义/脏数据）→ 保持 NULL（即「未分类」）
    op.execute(
        sa.text(
            "UPDATE quote_provider_interfaces "
            "SET category_id = ("
            "    SELECT quote_provider_interface_categories.id "
            "    FROM quote_provider_interface_categories "
            "    WHERE quote_provider_interface_categories.key = quote_provider_interfaces.interface_type"
            ") "
            "WHERE quote_provider_interfaces.interface_type IS NOT NULL"
        )
    )

    # ③ 删除旧 interface_type 列
    op.drop_column("quote_provider_interfaces", "interface_type")

    # ④ 删除分类表 key 列（UNIQUE 约束随列删除由 PostgreSQL 自动移除）
    op.drop_column("quote_provider_interface_categories", "key")


def downgrade() -> None:
    # ④ 反向：重加 key 列（先可空，回填后转 NOT NULL 以满足原约束）
    op.add_column(
        "quote_provider_interface_categories",
        sa.Column("key", sa.String(length=64), nullable=True),
    )
    op.execute(
        sa.text(
            "UPDATE quote_provider_interface_categories "
            "SET key = 'cat_' || replace(id, '-', '') "
            "WHERE key IS NULL"
        )
    )
    op.alter_column("quote_provider_interface_categories", "key", nullable=False)
    op.create_unique_constraint(
        "uq_quote_provider_interface_categories_key",
        "quote_provider_interface_categories",
        ["key"],
    )

    # ③ 反向：重加 interface_type 列（先可空，回填后转 NOT NULL）
    op.add_column(
        "quote_provider_interfaces",
        sa.Column("interface_type", sa.String(length=64), nullable=True),
    )
    op.execute(
        sa.text(
            "UPDATE quote_provider_interfaces "
            "SET interface_type = COALESCE(("
            "    SELECT quote_provider_interface_categories.key "
            "    FROM quote_provider_interface_categories "
            "    WHERE quote_provider_interface_categories.id = quote_provider_interfaces.category_id"
            "), 'uncategorized')"
        )
    )
    op.alter_column("quote_provider_interfaces", "interface_type", nullable=False)

    # ① 反向：删外键 + 索引 + category_id 列
    op.drop_constraint(
        "fk_quote_provider_interfaces_category_id",
        "quote_provider_interfaces",
        type_="foreignkey",
    )
    op.drop_column("quote_provider_interfaces", "category_id")
