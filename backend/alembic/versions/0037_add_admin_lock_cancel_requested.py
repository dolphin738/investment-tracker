"""``admin_locks`` 新增取消请求标记列 ``cancel_requested_at``（跨进程取消）。

背景：取消端点此前只能取消**本进程**的播种任务——``trigger_router.seed_task`` 是模块级
进程内变量，多 worker 下任务若在 worker B，请求打到 worker A 时 ``seed_task is None``，
直接 409「当前没有正在运行的任务」，用户点不动（DB 锁能感知跨进程占用，取消却不能）。

本列让取消成为**跨进程可见的信号**：取消端点只**置标记**（不依赖本进程是否持有任务对象），
持锁 worker 的播种循环在每个检查点自检该标记后自行退出。

- upgrade：加列 ``cancel_requested_at``（``DateTime(timezone=True)``，可空）。
  ``NULL`` = 无取消请求；非 NULL = 已请求取消（值为请求时刻）。
- downgrade：反向删列。

与锁的关系（关键，防残留）：``release_admin_lock`` 释放锁时**一并清空**该列，
故一次运行的取消标记不会泄漏到下一次运行（下次一启动就被「取消」）。
TTL 抢占陈旧锁时由 acquire 的 ``SET`` 天然覆盖为新 NULL 亦可，但释放路径必须清。

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
