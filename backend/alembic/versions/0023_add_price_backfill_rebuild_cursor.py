"""股息率方案：历史行情回补新增「全量重抓（rebuild）」模式的游标列。

- upgrade：``dividend_yield_settings`` 加 ``price_backfill_rebuild_cursor``（可空
  VARCHAR(36)），记录 rebuild 模式已重抓到的最后一只 ``master_id``（游标）。
  池 = 有分红记录的证券，按 ``master_id`` 升序推进；取不出下一批即判「池尾」→ 终态
  （清游标 + 清在途标记）。

  为什么需要它：legacy / gap 的选批判据本身会收敛（「起点未覆盖」/「有未耗尽洞」），
  抓完自然选不出人；而 rebuild **不做覆盖度筛选**（目标就是重抓全部、抹平复权口径差异），
  没有游标就会每轮重新选中全池 → 任务永不结束、每日额度天天烧满。
  存量行 NULL = 未开始 / 无进行中的重抓。
- 接续 0022（纯增量：单列）；downgrade 完整反向（drop_column），可往返。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "0023_add_price_backfill_rebuild_cursor"
down_revision: str | None = "0022_add_price_backfill_adjust"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]


def upgrade() -> None:
    op.add_column(
        "dividend_yield_settings",
        sa.Column("price_backfill_rebuild_cursor", sa.String(36), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("dividend_yield_settings", "price_backfill_rebuild_cursor")
