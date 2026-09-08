"""修正「东财-分红配送」响应字段名（旧库遗留值导致季度抓取全量跳行）。

**缺陷**：接口 ``resp_code_field``/``resp_name_field`` 在部分库（如开发库遗留行）为
``'code'``/``'name'``，但该接口走 akshare ``stock_fhps_em``，返回列名是**中文**
``代码``/``名称``（见 akshare ``stock_feature/stock_fhps_em.py`` 硬编码列名表）。
``dividend_sync`` 与 ``_prepare_master_rows`` 均按配置字段名取值，取不到即跳行
——表现为「季度抓取抓回上万行却 0 条落库、0 只重算」，且全程静默无报错。

**为何不靠 0004 seed 修复**：0004 的 seed 写的是正确的 ``'代码'``/``'名称'``，但用了
``WHERE NOT EXISTS(name)`` 幂等保护，已存在的旧遗留行不会被纠正。本迁移用 UPDATE
（而非 INSERT）做**真幂等**修正，新旧库都收敛到同一正确值。

Revision ID: 0009_fix_dividend_interface_code_fields
Revises: 0008_remove_dividend_yield_rebuild_task
Create Date: 2026-09-08
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "0009_fix_dividend_interface_code_fields"
down_revision: str | None = "0008_remove_dividend_yield_rebuild_task"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]

_NAME = "东财-分红配送"
_CORRECT = ("代码", "名称")
_LEGACY = ("code", "name")


def _set(code_field: str, name_field: str) -> None:
    op.execute(
        sa.text(
            "UPDATE quote_provider_interfaces "
            "SET resp_code_field = :code_field, resp_name_field = :name_field, updated_at = now() "
            "WHERE name = :itf_name"
        ).bindparams(
            code_field=code_field, name_field=name_field, itf_name=_NAME
        )
    )


def upgrade() -> None:
    """把两条字段统一纠正为 akshare 实际返回的中文列名（重复执行无副作用）。"""
    _set(*_CORRECT)


def downgrade() -> None:
    """回到本迁移前的遗留值（仅用于回滚场景，非推荐配置）。"""
    _set(*_LEGACY)
