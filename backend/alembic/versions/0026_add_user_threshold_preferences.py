"""用户偏好新增股息率标色阈值列（阈值随账号存储 · 第 1 步）。

背景：股息率「高/低」标色阈值原为**全局单行**配置（``dividend_yield_settings``，
admin 写、且前端整包按 admin 门控），导致非 admin 读不到、也不能各账号各设。
改为**每账号一份**、落 ``user_preferences``；读口复用既有的登录可用端点
``GET /api/users/preferences``（无需新增端点，也不再受 admin 限制）。

本迁移（第 1 步 · 纯增量、可往返）：

- upgrade：给 ``user_preferences`` 加两列
  - ``green_threshold``：高股息线阈值（小数比率），``Numeric(5, 4)``，非空，默认 0.05；
  - ``red_threshold``：低股息线阈值，``Numeric(5, 4)``，非空，默认 0.03。
  用 ``server_default`` 保证既有偏好行与新建行都有兜底值。本迁移**不回填**原全局值，
  所有账号统一取 0.05 / 0.03 默认（口径决策 D2）。
- downgrade：仅 drop 两列。

注意：原全局列 ``dividend_yield_settings.green_threshold/red_threshold`` 在本步
**保留**（标 deprecated，产品面已无入口），其删除走单独的第 2 步迁移。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "0026_add_user_threshold_preferences"
down_revision: str | None = "0025_drop_redundant_daily_price_index"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]


def upgrade() -> None:
    op.add_column(
        "user_preferences",
        sa.Column(
            "green_threshold",
            sa.Numeric(5, 4),
            nullable=False,
            server_default="0.05",
        ),
    )
    op.add_column(
        "user_preferences",
        sa.Column(
            "red_threshold",
            sa.Numeric(5, 4),
            nullable=False,
            server_default="0.03",
        ),
    )


def downgrade() -> None:
    op.drop_column("user_preferences", "red_threshold")
    op.drop_column("user_preferences", "green_threshold")
