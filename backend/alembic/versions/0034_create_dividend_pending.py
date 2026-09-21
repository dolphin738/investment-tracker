"""分红待划分 staging 队列建表（批次 B，§3）。

建 ``security_dividend_pending``：承接巨潮「现金 >0 但报告时间不可解析」的行（
``parse_cninfo_row_ex`` 的 ``no_period`` 桶），人工裁定报告期后写回主表
``security_dividends``。幂等键为 ``row_fingerprint``（sha1 hex，40 字符）**单列唯一**——
刻意不用复合唯一键：复合键含可空日期，PG 唯一索引对 NULL 视为互不相等，无法幂等（§3.6）。

同时创建 PG 原生枚举 ``DividendPendingStatus``（PENDING/ASSIGNED/IGNORED）。

⚠️ 本迁移**单事务原子**：仅 CREATE TYPE + CREATE TABLE + CREATE INDEX，无 ``ALTER TYPE
ADD VALUE``（故不需要 ``autocommit_block()``）。

downgrade 顺序**不可颠倒**：先 drop 索引 → 再 ``drop_table`` → 最后 ``DROP TYPE``；
反序会因「列仍引用该类型」报依赖错误（§3.4）。
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0034_create_dividend_pending"
down_revision: str | None = "0033_extend_report_period_type"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]

# 原生枚举值（与 app.models.enums.DividendPendingStatus 一致；顺序无排序约束）
_PENDING_STATUS_VALUES = ("PENDING", "ASSIGNED", "IGNORED")


def upgrade() -> None:
    # 1) 先建原生枚举类型（列引用处 create_type=False，避免 create_table 隐式重复建类型）
    postgresql.ENUM(
        *_PENDING_STATUS_VALUES, name="DividendPendingStatus", create_type=False
    ).create(op.get_bind(), checkfirst=True)

    # 2) 建表（master_id 外键 deferrable/initially DEFERRED，对齐 security_dividends）
    op.create_table(
        "security_dividend_pending",
        sa.Column(
            "id",
            sa.String(36),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "master_id",
            sa.String(36),
            sa.ForeignKey(
                "securities.id",
                ondelete="CASCADE",
                deferrable=True,
                initially="DEFERRED",
            ),
            nullable=False,
        ),
        sa.Column("row_fingerprint", sa.String(40), nullable=False),
        sa.Column("dividend_label", sa.String(32), nullable=True),
        sa.Column("cash_per_share", sa.Numeric(18, 6), nullable=False),
        sa.Column("bonus_share_ratio", sa.Numeric(18, 6), nullable=True),
        sa.Column("convert_ratio", sa.Numeric(18, 6), nullable=True),
        sa.Column("record_date", sa.Date(), nullable=True),
        sa.Column("ex_dividend_date", sa.Date(), nullable=True),
        sa.Column("pay_date", sa.Date(), nullable=True),
        sa.Column("announcement_date", sa.Date(), nullable=True),
        sa.Column("report_period_raw", sa.String(32), nullable=True),
        sa.Column(
            "status",
            postgresql.ENUM(
                *_PENDING_STATUS_VALUES, name="DividendPendingStatus", create_type=False
            ),
            nullable=False,
            server_default=sa.text("'PENDING'"),
        ),
        # 人工裁定后的报告期类型：刻意用 String(16) 非 native enum（避免枚举演进触发重建）
        sa.Column("resolved_period_type", sa.String(16), nullable=True),
        sa.Column("resolved_report_year", sa.Integer(), nullable=True),
        sa.Column("resolved_report_quarter", sa.SmallInteger(), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolved_by", sa.String(36), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    # 3) 建索引：幂等键（唯一）+ status（计数/筛选）+ master_id（按证券查询/级联）
    op.create_index(
        "uq_security_dividend_pending_fingerprint",
        "security_dividend_pending",
        ["row_fingerprint"],
        unique=True,
    )
    op.create_index(
        "ix_security_dividend_pending_status",
        "security_dividend_pending",
        ["status"],
    )
    op.create_index(
        "ix_security_dividend_pending_master",
        "security_dividend_pending",
        ["master_id"],
    )


def downgrade() -> None:
    # 顺序不可颠倒：先索引 → 再删表 → 最后 DROP TYPE（反序会报类型依赖错误）。
    # 唯一索引 uq_..._fingerprint 随 drop_table 一并删除，无需显式 drop。
    op.drop_index(
        "ix_security_dividend_pending_master", table_name="security_dividend_pending"
    )
    op.drop_index(
        "ix_security_dividend_pending_status", table_name="security_dividend_pending"
    )
    op.drop_table("security_dividend_pending")
    op.execute('DROP TYPE "DividendPendingStatus"')
