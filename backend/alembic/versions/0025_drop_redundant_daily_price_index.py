"""下线 ``market_security_daily_prices`` 上的冗余普通索引。

背景：0004 建表时同时声明了

- 唯一约束 ``uq_market_daily_price_master_date``（master_id, trade_date）；
- 普通索引 ``ix_market_daily_price_master_date``（master_id, trade_date）。

PostgreSQL 的唯一约束本身就是靠一棵唯一 btree 索引实现的，两者列集与列序完全相同，
于是库里长期并存两棵内容等价的 btree：查询优化器只会用到其中一棵，另一棵仅在每次
INSERT/UPDATE 时白白多一次索引维护。按 4600 只 × 243 交易日 ≈ 112 万行/年估算，
该冗余索引约白占 70MB/年。

下线后：

- ``(master_id, trade_date)`` 的等值/范围查询仍走唯一索引，执行计划不受影响；
- 唯一约束保留，upsert 幂等语义不变（冲突判定依赖 ``(master_id, trade_date)``）。

upgrade/downgrade 均带 IF [NOT] EXISTS，允许在「索引已被手工删除 / 已重建」的漂移库上
重复执行而不报错。
"""
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0025_drop_redundant_daily_price_index"
down_revision: str | None = "0024_add_price_backfill_run_token_and_running"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]


def upgrade() -> None:
    op.drop_index(
        "ix_market_daily_price_master_date",
        table_name="market_security_daily_prices",
        if_exists=True,
    )


def downgrade() -> None:
    op.create_index(
        "ix_market_daily_price_master_date",
        "market_security_daily_prices",
        ["master_id", "trade_date"],
        if_not_exists=True,
    )
