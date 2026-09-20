"""分红事件表新增送股/转增比例两列（支持高送转数据落库）。

背景：分红采集链路迁至巨潮 ``stock_dividend_cninfo``（方案 §5.3）后，源站除「派息比例」
外还返回「送股比例」「转增比例」两列，源站口径均为**每 10 股**（每 10 股送 X 股 /
转 X 股）。采集侧按 §5.3 映射统一除以 10 折算为**每股**后落库，与既有的
``cash_per_share`` 单位口径一致。

- upgrade：给 ``security_dividends`` 加两列，均为 ``Numeric(18, 6)`` 且可空
  - ``bonus_share_ratio``：每股送股比例（送红股）；
  - ``convert_ratio``：每股转增比例（资本公积转增股本）。
  两列可空、无默认值、无回填：存量行（新浪旧行）保持 NULL，语义即「未采集到送转信息」，
  不参与后续复权重述因子计算（方案 §5.3.1 消费侧 #2）。
- downgrade：反向删两列（先 ``convert_ratio`` 再 ``bonus_share_ratio``，与加列顺序相反）。

技术约束：

- 纯加列、无枚举重建，按项目规范走 ``batch_alter_table``（SQLite/PG 双端兼容），
  不触碰枚举重建坑；本迁移不使用 ``op.execute()``。
- 接续 0028（当前实际 head）；两列为纯增量列，可往返。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "0030_add_dividend_bonus_columns"
down_revision: str | None = "0028_drop_price_backfill"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]


def upgrade() -> None:
    with op.batch_alter_table("security_dividends") as batch_op:
        batch_op.add_column(
            sa.Column("bonus_share_ratio", sa.Numeric(precision=18, scale=6), nullable=True)
        )
        batch_op.add_column(
            sa.Column("convert_ratio", sa.Numeric(precision=18, scale=6), nullable=True)
        )


def downgrade() -> None:
    with op.batch_alter_table("security_dividends") as batch_op:
        batch_op.drop_column("convert_ratio")
        batch_op.drop_column("bonus_share_ratio")
