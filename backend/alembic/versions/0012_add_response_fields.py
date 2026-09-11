"""quote_provider_interfaces 新增 response_fields JSON 列（P1 Expand）。

- 纯加列：``response_fields`` JSON，nullable，承载「字段映射表」（新真相）。
- 保留旧 4 列（``resp_code_field`` / ``resp_price_field`` / ``resp_name_field`` /
  ``resp_exchange_field``）+ ``response_parse.resp_date_field`` 作为回滚镜像（P1 双写），
  P3 收缩阶段才删，故本次**不删任何旧列**。
- 不涉及 PG 原生枚举，纯 ``sa.JSON`` 加列。
- downgrade 可用（``op.drop_column``）。

Revision ID: 0012_add_response_fields
Revises: 0011_dividend_special_backfill
"""
from alembic import op
import sqlalchemy as sa

revision: str = "0012_add_response_fields"
down_revision: str | None = "0011_dividend_special_backfill"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]


def upgrade() -> None:
    op.add_column(
        "quote_provider_interfaces",
        sa.Column(
            "response_fields",
            sa.JSON(),
            nullable=True,
            comment=(
                "响应字段映射："
                "[{key,label,slot,source,type,required,scale,unit,date_format}]；"
                "空则由旧 4 列合成（历史兼容）"
            ),
        ),
    )


def downgrade() -> None:
    op.drop_column("quote_provider_interfaces", "response_fields")
