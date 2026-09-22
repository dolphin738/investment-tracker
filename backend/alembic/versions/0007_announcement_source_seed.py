"""股息率方案 §5.4/§11.2-7：公司公告接口 seed 默认（分类 4 priority 最小 enabled 接口）。

为 ``dividend_yield_settings.announcement_source_interface_id``（0006 新增）补默认值：
仅当该字段为 NULL 时，回填分类 4「公司公告」内 priority 最小的 enabled 接口
（``WHERE announcement_source_interface_id IS NULL`` 即幂等守卫，重复执行不覆盖
admin 显式配置值；分类 4 无 enabled 接口时 FROM 子查询为空、零行更新，同样安全）。
与 0005「默认源按调用形态重选」同口径：只 UPDATE 既有行，不 INSERT 配置行。

downgrade 不清空该字段（幂等回填无破坏性；清空反而会让已生效的默认公司公告接口失效，
违背 §6.8 公告扫描 fail fast 前置条件）。

Revision ID: 0007_announcement_source_seed
Revises: 0006_add_announcement_source_to_settings
Create Date: 2026-09-07
"""
from alembic import op
from sqlalchemy import text

# revision identifiers, used by Alembic.
revision: str = "0007_announcement_source_seed"
down_revision: str | None = "0006_add_announcement_source_to_settings"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]

# op.execute() 只接受单条 SQL（项目既有约束）。

_SEED_SQL = text(
    "UPDATE dividend_yield_settings "
    "SET announcement_source_interface_id = sub.id "
    "FROM ("
    "  SELECT id FROM quote_provider_interfaces "
    "  WHERE category_id = '4' AND enabled "
    "  ORDER BY priority ASC NULLS LAST, id ASC "
    "  LIMIT 1"
    ") AS sub "
    "WHERE announcement_source_interface_id IS NULL"
)


def upgrade() -> None:
    op.execute(_SEED_SQL)


def downgrade() -> None:
    # 幂等回填不回退（与 0005 默认源收敛值口径一致），见模块 docstring。
    pass
