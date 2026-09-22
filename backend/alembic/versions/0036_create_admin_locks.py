"""新建 ``admin_locks``：跨进程管理端动作互斥锁（DB 行级，带 TTL）。

背景（多进程单飞缺口补强）：历史分红播种的单飞此前**仅**靠进程内 ``asyncio.Lock``
（``trigger_router._seed_lock``），只在单 worker 内有效——多 worker / 多副本部署下每个
进程各持一个 Lock，连点会各自启动一个约 10 小时的任务，并发打满 ``rate_limit=10/min``
预算。本表以**数据库行**作为跨进程共享的互斥标记（获取/释放的原子语句见
``app.services.admin_lock``）。

- upgrade：建表 ``admin_locks``（``name`` 主键 / ``owner`` 可空 / ``acquired_at`` 可空）。
  ``owner`` 为 NULL 表示空闲；``acquired_at`` 配合 TTL 判据，防持锁进程崩溃后锁永久残留。
- downgrade：反向删表。

技术约束：
- 纯建表、无枚举 / 无外键 → 单事务原子，可往返（downgrade 直接 drop）。
- 接续 0035（创建时的实际 head；新迁移须先 ``alembic heads`` 确认，勿照抄旧编号）。
- 表结构与 ``app.models.admin_lock.AdminLock`` 一一对应：模型已注册进 ``Base.metadata``，
  否则 ``alembic revision --autogenerate`` 会把这张「DB 有、metadata 无」的表判为多余
  并生成 ``op.drop_table()``。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "0036_create_admin_locks"
down_revision: str | None = "0035_add_dividend_retention_years"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]


def upgrade() -> None:
    op.create_table(
        "admin_locks",
        sa.Column("name", sa.String(length=64), primary_key=True),
        sa.Column("owner", sa.String(length=36), nullable=True),
        sa.Column("acquired_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("admin_locks")
