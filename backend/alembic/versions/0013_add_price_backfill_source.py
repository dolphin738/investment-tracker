"""股息率方案：``dividend_yield_settings`` 新增历史行情回补源配置列。

- upgrade：加 ``price_backfill_source_interface_id``（可空 FK → ``quote_provider_interfaces.id``，
  ``ondelete="SET NULL"``）。该接口为「历史行情回补接口」，走路线 B（akshare ``stock_zh_a_hist``，
  决策 A15），须为分类 2 行情源 + 接入方式 sdk（路由层 ``PUT`` 校验 + ``/backfill-prices`` 运行时校验）。
- 与 0006 公告源同构（纯增量列）；revision 字符串 31 字符，未超 ``alembic_version.version_num``
  既有的 VARCHAR(64) 上限（0006 已扩），故 upgrade 无需再扩列。
- downgrade：仅 drop 该列（纯增量列，可往返）。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "0013_add_price_backfill_source"
down_revision: str | None = "0012_add_response_fields"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]


def upgrade() -> None:
    op.add_column(
        "dividend_yield_settings",
        sa.Column(
            "price_backfill_source_interface_id",
            sa.String(36),
            sa.ForeignKey("quote_provider_interfaces.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("dividend_yield_settings", "price_backfill_source_interface_id")
