"""将 portfolio_securities.master_id 外键改为 DEFERRABLE INITIALLY DEFERRED。

背景：证券主数据自愈（_normalize_and_dedupe_masters）在重推 code/asset_class 后，
需把 securities.id 从随机 UUID 重派生为 master_id_for(asset_class, code)，并同步迁移
portfolio_securities.master_id 引用。重派生分两步：先把子表引用迁到新 id，再把父表
securities.id 改为新 id。非延迟外键会在「改父表主键时子表仍引用旧 id」这一步立即报
ForeignKeyViolationError。改为延迟到事务提交时检查即可让两步都落库后再统一校验，
彼时子表已指向新 id，约束一致。

仅改外键的可延迟属性，不动列、不动数据、不破坏既有迁移链。
"""
from __future__ import annotations

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "t0u1v2w3x4y5"
down_revision: str | None = "s1a2b3c4d5e6f"
branch_labels: str | None = None
depends_on: str | None = None

_FK_NAME = "portfolio_securities_master_id_fkey"


def upgrade() -> None:
    op.drop_constraint(_FK_NAME, "portfolio_securities", type_="foreignkey")
    op.create_foreign_key(
        _FK_NAME,
        "portfolio_securities",
        "securities",
        ["master_id"],
        ["id"],
        ondelete="CASCADE",
        deferrable=True,
        initially="DEFERRED",
    )


def downgrade() -> None:
    op.drop_constraint(_FK_NAME, "portfolio_securities", type_="foreignkey")
    op.create_foreign_key(
        _FK_NAME,
        "portfolio_securities",
        "securities",
        ["master_id"],
        ["id"],
        ondelete="CASCADE",
    )
