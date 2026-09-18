"""历史行情回补：新增「回补起始日期配置默认值」列。

与在途标记 ``price_backfill_start_date`` 解耦：后者由触发/完成流程服务端管理
（POST /backfill-prices 写入、补完清空），PUT 不接受；前者为用户可在全局设置中保存的
偏好回补起点，PUT 接收并落库，触发回补时以本值为起点。

修复「回补起始日期更改后无法保存」——该输入框此前是纯前端本地 ref、不进 PUT 请求体，
改了等于没保存；重开页面又回到默认「一年前」。现在它由 settingsForm 持有、随设置保存。

依赖：紧随 0016 之后（0016 目前与 0015 同为工作树未提交改动，须一并提交，否则迁移链断）。

Revision ID: 0017_add_price_backfill_default_start_date
Revises: 0016_add_price_backfill_daily_usage
"""
from alembic import op
import sqlalchemy as sa

revision: str = "0017_add_price_backfill_default_start_date"
down_revision: str | None = "0016_add_price_backfill_daily_usage"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]


def upgrade() -> None:
    op.add_column(
        "dividend_yield_settings",
        sa.Column("price_backfill_default_start_date", sa.Date(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("dividend_yield_settings", "price_backfill_default_start_date")
