"""securities master data + quote interface master_list purpose (股票列表和测试).

Revises: h7c8d9e0f1g2
- SecurityType 原生枚举扩展 HK_STOCK / CONVERTIBLE_BOND / ETF / INDEX
  （ALTER TYPE ADD VALUE 不能在事务块内执行，故用 autocommit_block 单独执行）。
- securities：portfolio_id 改可空 + 新增 exchange / pinyin_initials / asset_class
  + 部分唯一索引 uq_securities_master_asset_code(asset_class, code) WHERE portfolio_id IS NULL
  + ix_securities_pinyin_initials 索引。
- quote_provider_interfaces：新增 purpose / asset_class / resp_name_field / resp_exchange_field。

Create Date: 2026-08-13
"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from sqlalchemy.sql import text

# revision identifiers, used by Alembic.
revision: str = "i8d9e0f1g2h3"
down_revision: str | None = "h7c8d9e0f1g2"
branch_labels: str | None = None
depends_on: str | None = None

# SecurityType 既有值之外的扩展值（§11.3）
NEW_SECURITY_TYPES = ("HK_STOCK", "CONVERTIBLE_BOND", "ETF", "INDEX")


def upgrade() -> None:
    # 1) 扩展 SecurityType 原生枚举。PG 要求 ALTER TYPE ADD VALUE 不能在事务块内执行，
    #    autocommit_block 将其隔离在独立 autocommit 连接上执行。
    ctx = op.get_context()
    with ctx.autocommit_block():
        for v in NEW_SECURITY_TYPES:
            op.execute(
                text(f"ALTER TYPE \"SecurityType\" ADD VALUE IF NOT EXISTS '{v}'")
            )

    # 2) securities：portfolio_id 可空 + 主数据字段
    # 新建原生枚举 InterfacePurpose（CREATE TYPE 允许在事务内执行；DO 块保证幂等）
    op.execute(
        text(
            "DO $$ BEGIN "
            "IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='interfacepurpose') "
            "THEN CREATE TYPE \"InterfacePurpose\" AS ENUM ('QUOTE','MASTER_LIST'); "
            "END IF; END $$"
        )
    )
    op.alter_column(
        "securities",
        "portfolio_id",
        existing_type=sa.String(length=36),
        nullable=True,
        existing_nullable=False,
    )
    op.add_column(
        "securities",
        sa.Column("exchange", sa.String(length=10), nullable=True),
    )
    op.add_column(
        "securities",
        sa.Column("pinyin_initials", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "securities",
        sa.Column(
            "asset_class",
            # 复用既有 SecurityType 原生枚举（create_type=False 不重复建类型）
            postgresql.ENUM(
                "STOCK", "FUND", "BOND", "OTHER", "CASH",
                "HK_STOCK", "CONVERTIBLE_BOND", "ETF", "INDEX",
                name="SecurityType", create_type=False,
            ),
            nullable=True,
        ),
    )
    # 系统级主数据行（portfolio_id IS NULL）按 资产类别+code 唯一（部分唯一索引）
    op.create_index(
        "uq_securities_master_asset_code",
        "securities",
        ["asset_class", "code"],
        unique=True,
        postgresql_where=text("portfolio_id IS NULL"),
    )
    op.create_index(
        "ix_securities_pinyin_initials", "securities", ["pinyin_initials"], unique=False
    )

    # 3) quote_provider_interfaces：列表接口配置字段
    op.add_column(
        "quote_provider_interfaces",
        sa.Column(
            "purpose",
            # 新建原生枚举 InterfacePurpose（已在上方 DO 块创建，create_type=False 不重复建）
            postgresql.ENUM("QUOTE", "MASTER_LIST", name="InterfacePurpose", create_type=False),
            nullable=False,
            server_default="QUOTE",
        ),
    )
    op.add_column(
        "quote_provider_interfaces",
        sa.Column(
            "asset_class",
            postgresql.ENUM(
                "STOCK", "FUND", "BOND", "OTHER", "CASH",
                "HK_STOCK", "CONVERTIBLE_BOND", "ETF", "INDEX",
                name="SecurityType", create_type=False,
            ),
            nullable=True,
        ),
    )
    op.add_column(
        "quote_provider_interfaces",
        sa.Column(
            "resp_name_field",
            sa.String(length=64),
            nullable=True,
            server_default="name",
        ),
    )
    op.add_column(
        "quote_provider_interfaces",
        sa.Column("resp_exchange_field", sa.String(length=64), nullable=True),
    )


def downgrade() -> None:
    op.drop_index("ix_securities_pinyin_initials", table_name="securities")
    op.drop_index("uq_securities_master_asset_code", table_name="securities")
    op.drop_column("quote_provider_interfaces", "resp_exchange_field")
    op.drop_column("quote_provider_interfaces", "resp_name_field")
    op.drop_column("quote_provider_interfaces", "asset_class")
    op.drop_column("quote_provider_interfaces", "purpose")
    op.drop_column("securities", "asset_class")
    op.drop_column("securities", "pinyin_initials")
    op.drop_column("securities", "exchange")
    op.alter_column(
        "securities",
        "portfolio_id",
        existing_type=sa.String(length=36),
        nullable=False,
        existing_nullable=True,
    )
    # PG 不支持 DROP VALUE，故不再回退 SecurityType 枚举值；
    # InterfacePurpose 类型在此保留（无害，且不影响既有表）。
