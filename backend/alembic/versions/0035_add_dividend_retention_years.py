"""股息率全局配置新增留存窗年数（D-4 配置化）。

背景（设计 D-4）：留存窗年数此前硬编码在 ``dividend_sync._RETENTION_YEARS = 5``，
前端建议报告期算法若也硬编码 ``cur - 4`` 会随之漂移。owner 定为「完整可配」——把年数落
``dividend_yield_settings.dividend_retention_years``，采集侧改读本列、配置端点暴露读写。

- upgrade：给 ``dividend_yield_settings`` 加列 ``dividend_retention_years``（``Integer``，
  可空，``server_default='5'``）。可空 + 默认 5：存量单行配置自动获得 5；显式 NULL 语义
  为「用默认值」（读侧 ``_settings_out`` 回落 5）。
- downgrade：反向删列。

技术约束：
- 纯加列、无枚举重建 → 走 ``batch_alter_table``（同 ``0030``），单事务原子。
- 接续 0034（当前实际 head）；列为纯增量列，可往返。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "0035_add_dividend_retention_years"
down_revision: str | None = "0034_create_dividend_pending"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]


def upgrade() -> None:
    with op.batch_alter_table("dividend_yield_settings") as batch_op:
        batch_op.add_column(
            sa.Column(
                "dividend_retention_years",
                sa.Integer,
                nullable=True,
                server_default="5",
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("dividend_yield_settings") as batch_op:
        batch_op.drop_column("dividend_retention_years")
