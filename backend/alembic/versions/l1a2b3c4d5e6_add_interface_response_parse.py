"""add response_parse to quote_provider_interfaces

为接口表新增 `response_parse` JSON 列，承载接口级响应解析协议
{format, encoding, sep, line_regex, code_param}，用于接入腾讯财经等
非 JSON 文本源（gbk 编码 + ~ 分隔）。可空、默认 {}，向后兼容，无需重建表。

**迁移红线**：本文件必须接在链头 k0f1a2b3c4d5 之后（down_revision='k0f1a2b3c4d5'）。

Revision ID: l1a2b3c4d5e6
Revises: k0f1a2b3c4d5
Create Date: 2026-08-15 16:00:00.000000
"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "l1a2b3c4d5e6"
down_revision: str | None = "k0f1a2b3c4d5"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "quote_provider_interfaces",
        sa.Column("response_parse", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("quote_provider_interfaces", "response_parse")
