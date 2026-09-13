"""股息率方案：``dividend_yield_settings`` 新增交易日历刷新起始日期列。

- upgrade：加 ``trade_calendar_start_date``（可空 DATE），作为 ``refresh_trade_calendar``
  的窗口下限（只落该日及之后的交易日），让「交易日历刷新获取多长时间」可在
  全局设置-股息率-初始化块里配置，不再硬编码于 dividend_yield_refresh.py。
  None（未配置）沿用默认下限「去年 1 月 1 日」，故存量行无需回填。
- 接续 0019（纯增量列）；不暴露结束上限：数据源只给到当年末，配上限无意义。
- downgrade：仅 drop 该列（纯增量列，可往返）。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "0020_add_trade_calendar_start_date"
down_revision: str | None = "0019_add_trade_calendar_refresh_task"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]


def upgrade() -> None:
    op.add_column(
        "dividend_yield_settings",
        sa.Column("trade_calendar_start_date", sa.Date(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("dividend_yield_settings", "trade_calendar_start_date")
