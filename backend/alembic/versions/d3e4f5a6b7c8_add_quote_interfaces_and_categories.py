"""add quote_provider_interfaces + quote_provider_interface_categories

新增「提供方接口」与「接口分类」两张表，支持证券行情数据提供方下的接口 CRUD
与接口分类后台管理（系统管理扩展特性）。

- quote_provider_interfaces：provider_id 外键 → securities_data_providers.id，
  ON DELETE CASCADE（删除提供方级联删接口）；direction 用 PG 原生枚举 interface_direction。
- quote_provider_interface_categories：key 唯一约束；upgrade 末尾 INSERT 7 个预置分类。

**迁移红线**：本文件必须接在链头 c2d3e4f5a6b7 之后（down_revision='c2d3e4f5a6b7'），
严禁改动/删除 c2d3e4f5a6b7_add_quote_providers_drop_system_configs.py，否则断链。

Revision ID: d3e4f5a6b7c8
Revises: c2d3e4f5a6b7
Create Date: 2026-08-12 16:00:00.000000
"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "d3e4f5a6b7c8"
down_revision: str | None = "c2d3e4f5a6b7"
branch_labels: str | None = None
depends_on: str | None = None

# 预置接口分类（key / label / icon / sort_order），icon 取合理 lucide 名。
SEED_CATEGORIES: list[tuple[str, str, str, int]] = [
    ("ashare_list", "A股列表", "List", 1),
    ("ashare_quote", "A股行情", "LineChart", 2),
    ("hk_list", "港股列表", "ListOrdered", 3),
    ("hk_quote", "港股行情", "LineChart", 4),
    ("fund_list", "基金列表", "List", 5),
    ("convertible_list", "可转债列表", "ListChecks", 6),
    ("convertible_quote", "可转债行情", "TrendingUp", 7),
]


def upgrade() -> None:
    # 1) PG 原生枚举 `interface_direction` 由下方 quote_provider_interfaces 表的
    #    direction 列（sa.Enum('in','out', name='interface_direction')）在 op.create_table
    #    时自动创建一次（create_type 默认 True）。不要额外显式 CREATE TYPE，否则会重复创建报错。

    op.create_table(
        "quote_provider_interfaces",
        sa.Column(
            "id",
            sa.String(length=36),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column(
            "provider_id",
            sa.String(length=36),
            nullable=False,
            index=True,
        ),
        sa.Column("interface_type", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("endpoint", sa.String(length=512), nullable=True),
        sa.Column("http_method", sa.String(length=10), nullable=True),
        sa.Column("params", sa.JSON(), nullable=True),
        sa.Column(
            "enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "direction",
            sa.Enum("in", "out", name="interface_direction"),
            nullable=False,
            server_default="in",
        ),
        sa.Column("timeout", sa.Integer(), nullable=True),
        sa.Column("retry_count", sa.Integer(), nullable=True),
        sa.Column("rate_limit", sa.String(length=64), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["provider_id"],
            ["securities_data_providers.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "quote_provider_interface_categories",
        sa.Column(
            "id",
            sa.String(length=36),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("key", sa.String(length=64), nullable=False),
        sa.Column("label", sa.String(length=128), nullable=False),
        sa.Column("icon", sa.String(length=64), nullable=True),
        sa.Column(
            "sort_order",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("key"),
    )

    # 2) 预置 7 个接口分类
    bind = op.get_bind()
    for key, label, icon, sort_order in SEED_CATEGORIES:
        bind.execute(
            sa.text(
                "INSERT INTO quote_provider_interface_categories "
                "(id, key, label, icon, sort_order, created_at, updated_at) "
                "VALUES (gen_random_uuid(), :key, :label, :icon, :sort_order, now(), now())"
            ),
            {"key": key, "label": label, "icon": icon, "sort_order": sort_order},
        )


def downgrade() -> None:
    op.drop_table("quote_provider_interface_categories")
    op.drop_table("quote_provider_interfaces")
    op.execute(sa.text("DROP TYPE IF EXISTS interface_direction"))
