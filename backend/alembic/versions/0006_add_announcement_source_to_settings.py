"""股息率方案 §15.1 B1：``dividend_yield_settings`` 新增公告源配置列。

- upgrade：加 ``announcement_source_interface_id``（可空 FK → ``quote_provider_interfaces.id``，
  ``ondelete="SET NULL"``）。公告源 = 分类 4「公司公告」接口，供 §6.8 公告扫描使用
  （取代原按分类 4 写死取接口的实现，变为可配置，§5.4/§11.2 第 7 条）。
- 版本表扩容：本迁移 revision 字符串 43 字符，超过 ``alembic_version.version_num``
  默认 varchar(32) 上限（0003 注释的既有约束），故 upgrade 先扩列至 VARCHAR(64) 再落库；
  downgrade 不缩回（保证本 revision 及其后迁移可往返，幂等无破坏性）。
- downgrade：仅 drop 该列（纯增量列，可往返；不涉及枚举，无需 ``op.execute`` 多语句）。

Revision ID: 0006_add_announcement_source_to_settings
Revises: 0005_dividend_index_defaults
Create Date: 2026-09-07
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import text

# revision identifiers, used by Alembic.
revision: str = "0006_add_announcement_source_to_settings"
down_revision: str | None = "0005_dividend_index_defaults"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]


def upgrade() -> None:
    # revision 字符串超 varchar(32) 默认上限，先扩列（单条 ALTER，alembic_version 仅一行）
    op.execute(text("ALTER TABLE alembic_version ALTER COLUMN version_num TYPE VARCHAR(64)"))
    op.add_column(
        "dividend_yield_settings",
        sa.Column(
            "announcement_source_interface_id",
            sa.String(36),
            sa.ForeignKey("quote_provider_interfaces.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("dividend_yield_settings", "announcement_source_interface_id")
    # 版本列不缩回 VARCHAR(32)：本 revision 及其后迁移写入需要 VARCHAR(64)
