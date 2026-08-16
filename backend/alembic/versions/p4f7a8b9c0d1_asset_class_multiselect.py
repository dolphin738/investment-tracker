"""资产类别多选 + 未分类兜底（ADR/接口分类改版后续）

背景：接口 asset_class 由「单行强制打标」改为「仅用于同步选源批次归属」的多选字段；
主数据行级 asset_class 改为逐行由代码前缀 + 交易所推断（与组合持仓 type 同源），
无法可靠区分的类（如场外基金与 A股 同前缀）落 UNCATEGORIZED 未分类。

迁移内容：
1. SecurityType 原生枚举新增 'UNCATEGORIZED' 值（PG12+ 允许事务内 ADD VALUE，
   本迁移不使用该值，仅枚举定义扩展，无事务冲突）。
2. quote_provider_interfaces.asset_class：标量原生枚举 → text[]（多选，
   存 SecurityType 值字符串），已有标量值经 ARRAY[asset_class::text] 升级为单元素数组。
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import text
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "p4f7a8b9c0d1"
down_revision: str | None = "o3d4e5f6a7b8"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    # 1) 新增未分类枚举值（仅扩展定义，本事务不使用，PG16 事务内合法）
    #    枚举类型名带大写，必须加引号（"SecurityType"）。
    op.execute(text('ALTER TYPE "SecurityType" ADD VALUE IF NOT EXISTS \'UNCATEGORIZED\''))
    # 2) 接口 asset_class 改为多选数组（存枚举值字符串）
    op.alter_column(
        "quote_provider_interfaces",
        "asset_class",
        type_=postgresql.ARRAY(sa.String(20)),
        postgresql_using="ARRAY[asset_class::text]",
        existing_nullable=True,
    )


def downgrade() -> None:
    # 回退：数组塌缩回标量（取首个元素）。未分类枚举值 PG16 不可事务内移除，略过。
    op.alter_column(
        "quote_provider_interfaces",
        "asset_class",
        type_=postgresql.ARRAY(sa.String(20)),
        postgresql_using="asset_class[1]",
        existing_nullable=True,
    )
