"""证券数据模型拆表：目录表 securities + 组合持仓表 portfolio_securities（ADR-003）。

D1 已决「干净重建」：本迁移仅含 schema 操作，不迁移任何存量数据。
- securities 去 portfolio_id / type / currency 列；唯一约束收敛为 (asset_class, code)。
- 新增 portfolio_securities（组合持仓表），承载 trades/prices/dividends。
- SecurityTrade/SecurityPrice/DividendRecord.security_id 外键目标由 securities.id
  改为 portfolio_securities.id（ondelete=CASCADE 不变）。

应用方式（D1）：因涉及外键目标切换与列删除，建议在「整库重建」后跑 alembic upgrade head
（开发库先 pg_dump，再 DROP+CREATE 后 upgrade head；测试库由 conftest 每会话自动重建），
而非对含数据的旧库做增量升级。SecurityType 原生枚举沿用既有类型（create_type=False），
由本迁移之前的 securities.type 列创建，删除该列不删除枚举类型。
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from app.models.enums import SecurityType

# revision identifiers, used by Alembic.
revision = "k0f1a2b3c4d5"
down_revision = "j9e0f1a2b3c4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1) securities：先删旧约束/索引，再删列，最后加新唯一约束
    op.drop_constraint("uq_securities_portfolio_code", "securities", type_="unique")
    op.drop_index("uq_securities_master_asset_code", table_name="securities")
    op.drop_column("securities", "portfolio_id")
    op.drop_column("securities", "type")
    op.drop_column("securities", "currency")
    op.create_unique_constraint(
        "uq_securities_asset_code", "securities", ["asset_class", "code"]
    )

    # 2) 三张子表外键目标：securities.id → portfolio_securities.id
    op.drop_constraint("security_trades_security_id_fkey", "security_trades", type_="foreignkey")
    op.drop_constraint("security_prices_security_id_fkey", "security_prices", type_="foreignkey")
    op.drop_constraint("dividend_records_security_id_fkey", "dividend_records", type_="foreignkey")

    # 3) 新建组合持仓表
    op.create_table(
        "portfolio_securities",
        sa.Column(
            "id",
            sa.String(36),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "portfolio_id",
            sa.String(36),
            sa.ForeignKey("portfolios.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "master_id",
            sa.String(36),
            sa.ForeignKey("securities.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "type",
            postgresql.ENUM(
                SecurityType,
                name="SecurityType",
                create_type=False,
            ),
            nullable=True,
        ),
        sa.Column("currency", sa.String(10), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "portfolio_id",
            "master_id",
            name="uq_portfolio_securities_portfolio_master",
        ),
    )
    op.create_index(
        "ix_portfolio_securities_portfolio", "portfolio_securities", ["portfolio_id"]
    )

    # 4) 子表外键指向新表
    op.create_foreign_key(
        "security_trades_security_id_fkey",
        "security_trades",
        "portfolio_securities",
        ["security_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "security_prices_security_id_fkey",
        "security_prices",
        "portfolio_securities",
        ["security_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "dividend_records_security_id_fkey",
        "dividend_records",
        "portfolio_securities",
        ["security_id"],
        ["id"],
        ondelete="CASCADE",
    )


def downgrade() -> None:
    # 1) 子表外键指回 securities.id
    op.drop_constraint("security_trades_security_id_fkey", "security_trades", type_="foreignkey")
    op.drop_constraint("security_prices_security_id_fkey", "security_prices", type_="foreignkey")
    op.drop_constraint("dividend_records_security_id_fkey", "dividend_records", type_="foreignkey")
    op.create_foreign_key(
        "security_trades_security_id_fkey",
        "security_trades",
        "securities",
        ["security_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "security_prices_security_id_fkey",
        "security_prices",
        "securities",
        ["security_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "dividend_records_security_id_fkey",
        "dividend_records",
        "securities",
        ["security_id"],
        ["id"],
        ondelete="CASCADE",
    )

    # 2) 删组合持仓表
    op.drop_index("ix_portfolio_securities_portfolio", table_name="portfolio_securities")
    op.drop_table("portfolio_securities")

    # 3) securities 复原列与旧约束
    op.drop_constraint("uq_securities_asset_code", "securities", type_="unique")
    op.add_column(
        "securities",
        sa.Column(
            "portfolio_id",
            sa.String(36),
            sa.ForeignKey("portfolios.id", ondelete="CASCADE"),
            nullable=True,
        ),
    )
    op.add_column(
        "securities",
        sa.Column(
            "type",
            postgresql.ENUM(
                SecurityType,
                name="SecurityType",
                create_type=False,
            ),
            nullable=True,
        ),
    )
    op.add_column(
        "securities",
        sa.Column("currency", sa.String(10), nullable=False, server_default="CNY"),
    )
    op.create_unique_constraint(
        "uq_securities_portfolio_code", "securities", ["portfolio_id", "code"]
    )
    op.create_index(
        "uq_securities_master_asset_code",
        "securities",
        ["asset_class", "code"],
        unique=True,
        postgresql_where=sa.text("portfolio_id IS NULL"),
    )
