"""接口分类改版：固定 2 类 + 废弃 InterfacePurpose

按 plan-interface-category-reform-2026-08-15 落地（用户明确"无需考虑存量数据"）：
1. 接口分类表新增 system 列（Boolean，default false）——标识系统内置分类。
2. 清空旧 7 个预置分类（接口 category_id 因 FK ON DELETE SET NULL 自动置空）。
3. INSERT 2 个固定 system 分类（显式固定 id，便于代码硬编码路由，不受重建影响）：
   - 1 证券列表（主数据拉取）
   - 2 证券行情（价格行情）
   与 backend/app/services/market_data_sync.py 的 MASTER_LIST_CAT_ID / QUOTE_CAT_ID 常量一致。
4. 删除 quote_provider_interfaces.purpose 列。
5. DROP TYPE "InterfacePurpose"（PG 原生枚举类型清理）。

注：种子迁移 d3e4f5a6b7c8 曾向 key 列 INSERT，但 key 列在后续 f5a6b7c8d9e0 已正常删除，
迁移链顺序执行后 schema 与模型一致，新鲜库不会报错，故本迁移不处理 key 列。

幂等 / 漂移容忍：本迁移所有 DDL 均带 IF [NOT] EXISTS 守卫，且分类表缺失时自动 CREATE
（建表 DDL 对齐 f5 之后无 key 列的真实结构）。这样无论是「全新迁移」还是开发库以
create_all + stamp 建库导致的漂移（漏建分类表 / 已无 purpose 列 / 已无 InterfacePurpose
枚举），一条 `alembic upgrade head` 都能收敛到同一终态，避免半程中断。
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import text
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "o3d4e5f6a7b8"
down_revision: str | None = "n2c3d4e5f6g7"
branch_labels: str | None = None
depends_on: str | None = None

# 固定分类 id（与 market_data_sync.MASTER_LIST_CAT_ID / QUOTE_CAT_ID 保持一致）
MASTER_LIST_CAT_ID = "1"
QUOTE_CAT_ID = "2"


def upgrade() -> None:
    # 1) 确保分类表存在（容忍开发库以 create_all+stamp 建库、漏建本表的漂移）：
    #    建表 DDL 对齐 f5 之后（已删 key 列）的真实结构，避免与全新迁移路径产生 schema 漂移。
    op.execute(
        text(
            "CREATE TABLE IF NOT EXISTS quote_provider_interface_categories ("
            "  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),"
            "  label VARCHAR(128) NOT NULL,"
            "  icon VARCHAR(64),"
            "  sort_order INTEGER NOT NULL DEFAULT 0,"
            "  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),"
            "  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()"
            ")"
        )
    )

    # 2) 新增 system 列（IF NOT EXISTS，可重复执行）
    op.execute(
        text(
            "ALTER TABLE quote_provider_interface_categories "
            "ADD COLUMN IF NOT EXISTS system BOOLEAN NOT NULL DEFAULT false"
        )
    )

    # 3) 清空旧分类（无存量数据，跳过旧类归并）；接口 category_id 自动置空
    op.execute(text("DELETE FROM quote_provider_interface_categories"))

    # 4) 插入 2 个固定 system 分类
    #    注：op.execute() 只接受单个 SQL 表达式，参数须用 text().bindparams() 绑定，
    #    不能像 Connection.execute() 那样传第二个 params 位置参数。
    op.execute(
        text(
            "INSERT INTO quote_provider_interface_categories "
            "(id, label, icon, sort_order, system, created_at, updated_at) "
            "VALUES "
            "(:ml_id, '证券列表', 'List', 1, TRUE, now(), now()), "
            "(:q_id, '证券行情', 'LineChart', 2, TRUE, now(), now())"
        ).bindparams(ml_id=MASTER_LIST_CAT_ID, q_id=QUOTE_CAT_ID)
    )

    # 5) 删除接口表 purpose 列（IF EXISTS，容忍已无该列的漂移库）
    op.execute(
        text("ALTER TABLE quote_provider_interfaces DROP COLUMN IF EXISTS purpose")
    )

    # 6) 清理 PG 原生枚举类型 InterfacePurpose（IF EXISTS）
    op.execute(text('DROP TYPE IF EXISTS "InterfacePurpose"'))


def downgrade() -> None:
    # 5) 重建枚举类型
    op.execute(
        text(
            "CREATE TYPE \"InterfacePurpose\" AS ENUM ('QUOTE', 'MASTER_LIST')"
        )
    )
    # 4) 恢复 purpose 列（枚举类型上一步已显式 CREATE，故 create_type=False 防重复创建）
    op.add_column(
        "quote_provider_interfaces",
        sa.Column(
            "purpose",
            postgresql.ENUM(
                "QUOTE", "MASTER_LIST", name="InterfacePurpose", create_type=False
            ),
            nullable=False,
            server_default="QUOTE",
        ),
    )
    # 3) 删除固定分类
    op.execute(
        text(
            "DELETE FROM quote_provider_interface_categories "
            "WHERE id IN (:ml_id, :q_id)"
        ).bindparams(ml_id=MASTER_LIST_CAT_ID, q_id=QUOTE_CAT_ID)
    )
    # 2) 移除 system 列
    op.drop_column("quote_provider_interface_categories", "system")
