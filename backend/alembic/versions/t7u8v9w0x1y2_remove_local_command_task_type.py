"""移除 LOCAL_COMMAND 任务类型（REP-003 · owner 裁决 C 档）。

背景：``JobTaskType.LOCAL_COMMAND`` 是产品内置的任意命令执行通道
（``app/core/scheduler.py`` 原 ``_local_command`` 用 ``subprocess.run(shell=True)``）。
虽创建 / 触发端点均收口在 ``require_admin``，但属「admin 会话一旦被劫持即一步拿到
容器 shell」的 RCE 原语。经裁决按 **C 档彻底移除**该任务类型（Python 端枚举成员、
处理器、管理端 handler 元数据已同步删除）。

⚠️ **关键事实：PostgreSQL 不支持 ``ALTER TYPE ... DROP VALUE``**

本迁移初版曾使用 ``ALTER TYPE "JobTaskType" DROP VALUE IF EXISTS 'LOCAL_COMMAND'``，
在 PG 16.14 实测报 ``syntax error at or near "VALUE"`` —— 已逐一验证
``DROP VALUE`` / ``DROP VALUE IF EXISTS`` / ``DROP VALUE ... CASCADE`` **三种写法均
语法错误**。PG 的 ``ALTER TYPE`` 对枚举仅支持 ``ADD VALUE`` 与 ``RENAME VALUE``，
**从未提供 DROP VALUE**。删除枚举值只剩两条路：

1. 直接删 ``pg_enum`` 系统表行（hack，非官方支持）；
2. **重建类型**（官方推荐路径）—— 本迁移采用。

重建步骤（顺序不可颠倒）：列降级为 ``text`` → 删旧类型 → 建新类型 → 列改回枚举。
整个 ``upgrade()`` 在同一事务内执行，PG 支持事务性 DDL，故失败可整体回滚。

前置：必须先删除 ``task_type='LOCAL_COMMAND'`` 的存量行，否则列降级为 text 后再
转回新枚举时，残留值无法 CAST（新类型无该值）而失败。

⚠️ **破坏性**：会永久删除存量 LOCAL_COMMAND 任务及其运行日志，downgrade
**无法恢复**这些数据（仅能加回枚举值）。

接在 ``w3x4y5z6a7b8`` 之后（``down_revision='w3x4y5z6a7b8'``），
严禁改动既有迁移文件，否则断链。
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
    # 1) 清理存量任务及其日志（先删子表；父表外键为 ON DELETE CASCADE，
    #    显式删除更稳妥，也避免列降级后残留值无法转回新枚举）
    op.execute(
        text(
            """
            DELETE FROM job_run_logs
            WHERE job_id IN (
                SELECT id FROM job_configs WHERE task_type::text = 'LOCAL_COMMAND'
            )
            """
        )
    )
    op.execute(
        text("DELETE FROM job_configs WHERE task_type::text = 'LOCAL_COMMAND'")
    )

    # 2) 重建枚举类型（PG 无 DROP VALUE，见模块 docstring）
    _rebuild_enum(_VALUES_AFTER)


def downgrade() -> None:
    # 加回枚举值（对称重建）。已删除的存量任务与运行日志无法恢复。
    _rebuild_enum(_VALUES_BEFORE)
