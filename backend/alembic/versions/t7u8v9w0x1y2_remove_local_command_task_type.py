"""移除 LOCAL_COMMAND 任务类型（REP-003 · owner 裁决 C 档，精简版）。

背景：``JobTaskType.LOCAL_COMMAND`` 是产品内置的任意命令执行通道
（``app/core/scheduler.py`` 原 ``_local_command`` 用 ``subprocess.run(shell=True)``）。
虽创建 / 触发端点均收口在 ``require_admin``，但属「admin 会话一旦被劫持即一步拿到
容器 shell」的 RCE 原语。经裁决按 **C 档彻底移除**该任务类型（Python 端枚举成员、
处理器、管理端 handler 元数据已同步删除）。

⚠️ **关键事实：PostgreSQL 不支持 ``ALTER TYPE ... DROP VALUE``**

PG 的 ``ALTER TYPE`` 对枚举仅支持 ``ADD VALUE`` 与 ``RENAME VALUE``，**从未提供
DROP VALUE**。本迁移初版曾尝试 ``ALTER TYPE "JobTaskType" DROP VALUE 'LOCAL_COMMAND'``，
在 PG 16.14 实测报 ``syntax error at or near "VALUE"``。删除枚举值只剩两条路：

1. 直接删 ``pg_enum`` 系统表行（hack，非官方支持）；
2. **重建类型**（官方推荐路径）—— 本迁移采用。

重建步骤（顺序不可颠倒）：列降级为 ``text`` → 删旧类型 → 建新类型 → 列改回枚举。
整个 ``upgrade()`` 在同一事务内执行，PG 支持事务性 DDL，故失败可整体回滚。

**数据清理（精简版已移除）**：各环境（dev / test / prod）均确认无 ``LOCAL_COMMAND``
存量任务与日志，故本迁移**不再包含 ``DELETE`` 语句**——仅重建枚举即可完成移除，
不触碰任何业务数据。若某环境实际存在 ``LOCAL_COMMAND`` 存量行，列改回新枚举时
残留值无法 CAST 而失败；此时需先手动清理存量行（见 git 历史中本迁移的初版 ``DELETE`` 实现）。

接在 ``w3x4y5z6a7b8`` 之后（``down_revision='w3x4y5z6a7b8'``），
严禁改动 revision / down_revision 指针，否则断链。
"""
from __future__ import annotations

from alembic import op
from sqlalchemy import text


# revision identifiers, used by Alembic.
revision: str = "t7u8v9w0x1y2"
down_revision: str | None = "w3x4y5z6a7b8"
branch_labels: str | None = None
depends_on: str | None = None

# 重建后的枚举值（移除 LOCAL_COMMAND，其余保持原有顺序）
_VALUES_AFTER = (
    "'MARKET_DATA_SYNC', 'SECURITY_MASTER_SYNC', 'HTTP_CALLBACK', "
    "'ACCOUNT_CLEANUP', 'LOG_CLEANUP'"
)
# 回滚时的枚举值（含 LOCAL_COMMAND，顺序与重建前一致）
_VALUES_BEFORE = (
    "'MARKET_DATA_SYNC', 'SECURITY_MASTER_SYNC', 'LOCAL_COMMAND', "
    "'HTTP_CALLBACK', 'ACCOUNT_CLEANUP', 'LOG_CLEANUP'"
)


def _rebuild_enum(values: str) -> None:
    """以给定值集合重建 "JobTaskType" 枚举，并把列改回该类型。"""
    op.execute(text("ALTER TABLE job_configs ALTER COLUMN task_type TYPE text"))
    op.execute(text('DROP TYPE "JobTaskType"'))
    op.execute(text(f'CREATE TYPE "JobTaskType" AS ENUM ({values})'))
    op.execute(
        text(
            'ALTER TABLE job_configs ALTER COLUMN task_type TYPE "JobTaskType" '
            'USING task_type::text::"JobTaskType"'
        )
    )


def upgrade() -> None:
    # 重建枚举类型（PG 无 DROP VALUE，见模块 docstring）。
    # 各环境均无 LOCAL_COMMAND 存量数据，无需 DELETE。
    _rebuild_enum(_VALUES_AFTER)


def downgrade() -> None:
    # 对称重建为初版 6 值枚举（含 LOCAL_COMMAND）。
    _rebuild_enum(_VALUES_BEFORE)
