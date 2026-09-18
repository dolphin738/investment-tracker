"""下线历史行情回补：删除 ``price_backfill_*`` 配置列与 ``market_price_backfill_gaps`` 洞表。

功能下线收尾（Expand→Contract 的 Contract 步）：历史行情回补（``/backfill-prices``）的端点、
服务与模型已从代码库移除，本迁移把 ``dividend_yield_settings`` 上残留的 12 个
``price_backfill_*`` 列与 ``market_price_backfill_gaps`` 洞表一并删除。

- 12 列：source_interface_id / quota / start_date / default_start_date / last_run_date /
  used_today / last_error / mode / rebuild_cursor / run_token / running / adjust。
- 洞表 ``market_price_backfill_gaps``（0021 建；drop_table 连带其两个索引）。

**幂等（关键）**：创建这些对象的 8 个增量迁移（0013/0014/0016/0017/0018/0022/0023/0024）
已从迁移链上物理删除，故**全新库**上这 12 列中只有 ``price_backfill_mode``（0021 建）存在、
其余 11 列不存在；洞表由 0021 建。全部 ``IF EXISTS`` 使本迁移在「全新库」与「存量库」两端
都安全（存量库 12 列 + 洞表俱在，全删；全新库只删 0021 残留）。

接续 0027。downgrade **不重建**：列/表的语义载体（回补端点/服务/模型）已随功能删除，
无法有意义回滚；如需恢复请从 ``archive-discontinued`` 分支取回原迁移与代码。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "0028_drop_price_backfill"
down_revision: str | None = "0027_drop_global_dividend_thresholds"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]

_TABLE = "dividend_yield_settings"
_COLUMNS = (
    "price_backfill_source_interface_id",
    "price_backfill_quota",
    "price_backfill_start_date",
    "price_backfill_default_start_date",
    "price_backfill_last_run_date",
    "price_backfill_used_today",
    "price_backfill_last_error",
    "price_backfill_mode",
    "price_backfill_rebuild_cursor",
    "price_backfill_run_token",
    "price_backfill_running",
    "price_backfill_adjust",
)


def upgrade() -> None:
    # 洞表（连带其索引）；IF EXISTS 兼容全新库 / 已被前置清理的场景
    op.execute(sa.text("DROP TABLE IF EXISTS market_price_backfill_gaps"))
    # 12 个配置列；op.execute() 只接受单条 SQL（项目既有约束），故逐条执行
    for col in _COLUMNS:
        op.execute(sa.text(f'ALTER TABLE {_TABLE} DROP COLUMN IF EXISTS "{col}"'))


def downgrade() -> None:
    # 不回滚：语义载体已随功能删除，恢复路径见模块 docstring。
    pass
