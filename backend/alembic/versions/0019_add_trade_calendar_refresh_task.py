"""新增系统定时任务：每日刷新交易日历（TRADE_CALENDAR_REFRESH）。

背景：交易日历刷新原先只在「五年股息留存清理」（DIVIDEND_RETENTION_CLEANUP，每年 1 月 1 日）
里顺带执行，导致 ``market_trade_calendar`` 长期为空——``is_trade_day`` 因日历空而 FAIL-OPEN
（§5.5 防线一失效）、stale 判定降级为快照表基准（§7）。本迁移把刷新拆成**独立系统定时任务**，
每日 08:00 刷新，让日历表稳定被填充。

- 原生枚举 ``JobTaskType`` 扩展 ``'TRADE_CALENDAR_REFRESH'``——PG 要求
  ``ALTER TYPE ADD VALUE`` 在事务块外执行，故用 ``autocommit_block`` 隔离
  （同 0011 对 ``DIVIDEND_SPECIAL_BACKFILL`` 的处理，本项目硬约定）。
- 种子写入系统任务行：``kind=SYSTEM``、``enabled=TRUE``、``cron='0 8 * * *'``（每日 08:00，
  早于「每日收盘价抓取」的 ``5 15 * * 1-5``，确保当日防线一有日历可用）；``name`` 唯一约束 +
  ``WHERE NOT EXISTS`` 兜底幂等。
- ``downgrade()``：删除种子行（枚举值不回收，PG 不支持 ``DROP VALUE``）。

Revision ID: 0019_add_trade_calendar_refresh_task
Revises: 0018_add_price_backfill_last_error
"""
from alembic import op
import sqlalchemy as sa

revision: str = "0019_add_trade_calendar_refresh_task"
down_revision: str | None = "0018_add_price_backfill_last_error"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]


_TASK_NAME = "交易日历刷新"
_DESCRIPTION = (
    "每日刷新交易日历（akshare tool_trade_date_hist_sina，保留 [今年-1, today+2年]）；"
    "供每日收盘价抓取的交易日校验（§5.5 防线一）与 stale 判定基准（§7）使用。"
    "不刷新则 is_trade_day 降级 FAIL-OPEN"
)

# 种子行 INSERT（提取为模块常量，供 upgrade 与单测共用——单一真相源，避免 SQL 重复/漂移）
_SEED_SQL = """
    INSERT INTO job_configs
        (id, name, task_type, kind, enabled, cron_expr, params, description,
         created_at, updated_at)
    SELECT
        gen_random_uuid(), :name,
        CAST('TRADE_CALENDAR_REFRESH' AS "JobTaskType"),
        CAST('SYSTEM' AS "JobKind"),
        TRUE, '0 8 * * *', '{}'::json, :desc,
        now(), now()
    WHERE NOT EXISTS (SELECT 1 FROM job_configs WHERE name = :name)
"""


def upgrade() -> None:
    # 1) 扩展原生枚举（ADD VALUE 须在 autocommit 块内执行，隔离独立事务）
    with op.get_context().autocommit_block():
        op.execute(
            sa.text(
                'ALTER TYPE "JobTaskType" ADD VALUE IF NOT EXISTS '
                "'TRADE_CALENDAR_REFRESH'"
            )
        )
    # 2) 种子系统任务行（enabled=TRUE：每日 08:00 自动刷新；name 唯一约束兜底幂等）
    op.execute(sa.text(_SEED_SQL).bindparams(name=_TASK_NAME, desc=_DESCRIPTION))


def downgrade() -> None:
    op.execute(
        sa.text("DELETE FROM job_configs WHERE name = :name").bindparams(
            name=_TASK_NAME
        )
    )
    # 枚举值不回收：PG 不支持 DROP VALUE，保留该值不影响运行（无行引用）。
