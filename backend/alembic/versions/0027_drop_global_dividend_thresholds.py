"""删除 ``dividend_yield_settings`` 的全局股息率标色阈值列（阈值迁用户偏好 · 第 2 步）。

背景：Step 1（0026）已把阈值迁至 ``user_preferences.green_threshold/red_threshold``，
前端「个人中心 → 偏好设置」成为唯一入口，榜单标色与曲线参考线均改读用户偏好；
``/api/dividend-yield/settings`` 端点亦不再接受/返回阈值字段。本表两列至此无任何读写方。

- upgrade：drop ``green_threshold`` / ``red_threshold``（**不可逆**：列内数据随之丢弃；
  用户的阈值已各自存于 ``user_preferences``，不受影响）。
- downgrade：加回两列（``NOT NULL`` + ``server_default`` 0.05/0.03）以支持回滚。
  注：0004 的原始定义**没有** server_default；此处必须补上——向已有数据的表加 ``NOT NULL``
  列若无默认值，downgrade 会直接失败。

口径决策：D1 = 本轮删除（用户 2026-09-17 裁决）。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "0027_drop_global_dividend_thresholds"
down_revision: str | None = "0026_add_user_threshold_preferences"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]


def upgrade() -> None:
    op.drop_column("dividend_yield_settings", "red_threshold")
    op.drop_column("dividend_yield_settings", "green_threshold")


def downgrade() -> None:
    op.add_column(
        "dividend_yield_settings",
        sa.Column(
            "green_threshold",
            sa.Numeric(5, 4),
            nullable=False,
            server_default="0.05",
        ),
    )
    op.add_column(
        "dividend_yield_settings",
        sa.Column(
            "red_threshold",
            sa.Numeric(5, 4),
            nullable=False,
            server_default="0.03",
        ),
    )
