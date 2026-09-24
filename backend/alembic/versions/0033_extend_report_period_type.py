"""分红报告期枚举扩展 + 原文标签列（批次 A 落地）。

1. 原生枚举 ``ReportPeriodType`` 由 4 值扩到 5 值：追加 ``OTHER``（股改分红 / 重整转增 /
   承诺补偿等 7 项非闭集词表中的「其它」兜底）。枚举定义顺序即排序顺序，
   ``OTHER`` 追加在末尾——``router`` 用 ``ORDER BY period_type.asc()`` 期望 OTHER 垫底。

2. ``security_dividends`` 新增 ``dividend_label``（varchar(32)，可空）：存储巨潮「分红类型」
   原文标签（如「股改分红」「重整转增」），用于展示与撞键判别；**不入唯一键**（唯一约束
   仍为 4 列 ``master_id/report_year/report_quarter/period_type``）。

⚠️ 本迁移**非原子**：两段落在两个事务——``ALTER TYPE ... ADD VALUE`` 必须 autocommit
（PG 不允许在事务块内 ADD VALUE 早于 PG12；PG12+ 可在事务内但新值提交前不可见），加列走
独立事务（``batch_alter_table``）。

残留情形与自愈：
- ALTER TYPE 成功、加列失败 → 枚举已含 OTHER、表缺 ``dividend_label`` 列。自愈：重跑
  ``alembic upgrade head``（ADD VALUE 幂等 ``IF NOT EXISTS``；batch 加列幂等可重入）。
- 整段失败（库连不上）→ 重跑即可；两段的 ``IF NOT EXISTS`` / 可重入特性保证可安全重试。

downgrade：删 ``dividend_label`` 列；枚举值 **no-op** —— PostgreSQL 不支持 ``DROP VALUE``，
枚举类型删除只能整类型 DROP（会连锁报所有引用列），代价不可接受，故 OTHER 枚举值保留。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "0033_extend_report_period_type"
down_revision: str | None = "0032_drop_dividend_report_source"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]


def upgrade() -> None:
    # ALTER TYPE 必须 autocommit（见模块 docstring 约束说明）。
    with op.get_context().autocommit_block():
        op.execute('ALTER TYPE "ReportPeriodType" ADD VALUE IF NOT EXISTS \'OTHER\'')
    with op.batch_alter_table("security_dividends") as batch_op:
        batch_op.add_column(
            sa.Column("dividend_label", sa.String(length=32), nullable=True)
        )


def downgrade() -> None:
    """删除 ``security_dividends.dividend_label`` 列。

    ⚠️ **本步丢数据、不可再生（S22 声明）**：该列存的是源站「分红类型」原文（L2 撞键护栏与
    前端标签展示都依赖它）。DROP 后列值全失；再 upgrade 回来只会重建**空列**
    （值全 NULL），要等采集侧全历史重跑才可能逐行回填。列级降级无法保数据（可接受），
    此处显式写明，以免运维误判「可安全回滚」。
    """
    with op.batch_alter_table("security_dividends") as batch_op:
        batch_op.drop_column("dividend_label")
    # 枚举值 OTHER **无法 DROP**（PG 不支持），保留之。仅注释说明，不执行任何 DDL。
