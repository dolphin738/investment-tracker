"""股息率方案：历史行情回补新增「世代标记」与「执行占用」两列。

- ``price_backfill_run_token``（可空 VARCHAR(36)）——**世代标记**：
  每次「触发回补」（``POST /backfill-prices``）写入一个新 UUID，取消（``DELETE``）
  清空为 NULL。运行中的回补任务启动时快照自己的 token，循环里比对：不一致即优雅中止
  （被取消 → NULL；被新一次触发取代 → 另一个 UUID）。

  为什么不能只看「在途标记是否为 NULL」：取消后该标记被清空，但用户可以**立刻重新触发**，
  标记随即又变成非 NULL —— 老批次无法区分「这个标记是我自己的」还是「新批次的」，
  会误判自己仍在有效期内、继续跑完（与新批次并发抓同一池子）。加入世代标记后，
  「取消」与「被取代」两种作废状态都能被老批次识别。

- ``price_backfill_running``（Boolean NOT NULL DEFAULT false）——**执行占用租约**：
  true 表示此刻正有一个回补 run 在抓取。单轮回补可跑数小时（``pending`` 上限 =
  当日剩余额度，10 只/批 + 60~120s 批间冷却），而 settings 行锁在第一次 commit 时
  就已释放，拦不住「管理员手动首批尚未跑完、15:05 每日收盘价抓取又并发起一个 run」。
  租约保证同一时刻只有一个 run（抢不到即跳过、不发请求）。
  进程重启时由应用启动流程复位，防止异常退出导致租约卡死。

- 接续 0023（纯增量：两列）；downgrade 完整反向（drop_column），可往返。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "0024_add_price_backfill_run_token_and_running"
down_revision: str | None = "0023_add_price_backfill_rebuild_cursor"
branch_labels = None  # type: ignore[attr-defined]
depends_on = None  # type: ignore[attr-defined]


def upgrade() -> None:
    op.add_column(
        "dividend_yield_settings",
        sa.Column("price_backfill_run_token", sa.String(36), nullable=True),
    )
    op.add_column(
        "dividend_yield_settings",
        sa.Column(
            "price_backfill_running",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("dividend_yield_settings", "price_backfill_running")
    op.drop_column("dividend_yield_settings", "price_backfill_run_token")
