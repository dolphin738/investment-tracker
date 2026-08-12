"""drop provider_type column from securities_data_providers

移除「数据来源」的 provider_type 列：该字段仅为展示性自由文本标识，
不参与任何运行时解析（当前/默认选择只看 is_active/is_default），且前后端
语义未统一（后端 docstring 指厂商、前端占位指资产类别），故整体移除。

链：接在 d3e4f5a6b7c8 之后。

Revision ID: e4f5a6b7c8d9
Revises: d3e4f5a6b7c8
Create Date: 2026-08-13 01:30:00.000000
"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "e4f5a6b7c8d9"
down_revision: str | None = "d3e4f5a6b7c8"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.drop_column("securities_data_providers", "provider_type")


def downgrade() -> None:
    op.add_column(
        "securities_data_providers",
        sa.Column("provider_type", sa.String(length=50), nullable=False),
    )
