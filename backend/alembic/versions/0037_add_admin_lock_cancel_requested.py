"""``admin_locks`` 新增取消请求标记列 ``cancel_requested_at``（跨进程取消）。

背景：取消端点此前只能取消**本进程**的播种任务——``trigger_router.seed_task`` 是模块级
进程内变量，多 worker 下任务若在 worker B，请求打到 worker A 时 ``seed_task is None``，
直接 409「当前没有正在运行的任务」，用户点不动（DB 锁能感知跨进程占用，取消却不能）。

本列让取消成为**跨进程可见的信号**：取消端点只**置标记**（不依赖本进程是否持有任务对象），
持锁 worker 的播种循环在每个检查点自检该标记后自行退出。

- upgrade：加列 ``cancel_requested_at``（``DateTime(timezone=True)``，可空）。
  ``NULL`` = 无取消请求；非 NULL = 已请求取消（值为请求时刻）。
- downgrade：反向删列。

与锁的关系（关键，防残留）：**两条路径都必须清空该列**，否则一次运行的取消标记会泄漏到
下一次运行，让新任务在第一个检查点就自检退出（表现为「刚点播种就秒取消」）：
- ``release_admin_lock`` 释放锁时一并清空（正常 / 抛错 / 取消路径）；
- ``acquire_admin_lock`` 抢占 TTL 陈旧锁时一并清空（``SET ..., cancel_requested_at = NULL``）
  —— 持锁进程崩溃来不及释放时走的正是这条路径。原注释曾断言「acquire 的 SET 天然覆盖为
  NULL」，这与当时的 SQL 不符（它只写 owner/acquired_at），现已补齐，两路径口径一致。

技术约束：
- 纯加列、无枚举 / 无外键 → 走 ``batch_alter_table``（同 ``0030``/``0035``），单事务原子。
- 接续 0036（创建时的实际 head）。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "0037_add_admin_lock_cancel_requested"
down_revision: str | None = "0036_create_admin_locks"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]


def upgrade() -> None:
    with op.batch_alter_table("admin_locks") as batch_op:
        batch_op.add_column(
            sa.Column("cancel_requested_at", sa.DateTime(timezone=True), nullable=True)
        )


def downgrade() -> None:
    with op.batch_alter_table("admin_locks") as batch_op:
        batch_op.drop_column("cancel_requested_at")
