"""统一定时任务调度：新建任务配置表 job_configs + 执行日志表 job_run_logs 与 4 个枚举。

背景：把两种既有定任务实现收敛为数据库驱动的 APScheduler AsyncIOScheduler：
- 行情同步（原 config.QUOTE_SYNC_SCHEDULER_ENABLED + scheduler.py BackgroundScheduler）
  → 迁为普通任务 MARKET_DATA_SYNC（默认关闭，沿用旧默认 cron `0 16 * * 1-5`）。
- 账户清理（原 external cron 调 /api/internal/cleanup/accounts）
  → 迁为系统任务 ACCOUNT_CLEANUP（kind=SYSTEM，默认开启，cron `0 4 * * *` 每日 04:00，
    对齐原 app @Cron(EVERY_DAY_AT_4AM) 建议频率）。
- 证券主数据同步 SECURITY_MASTER_SYNC 作为普通任务示例（默认关闭）。

任务归类权限：kind=SYSTEM 系统任务仅可编辑不可删除；kind=NORMAL 普通任务可增删改。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
# 列内枚举用 postgresql.ENUM(create_type=False)：由上方显式 CREATE 建枚举，
# 建表时不再重复 CREATE TYPE（sa.Enum 不接收 create_type，此处必须用 PG 专属 ENUM）
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "r6e5f4a3b2c1d"
down_revision: str | None = "q9a8b7c6d5e4"
branch_labels: str | None = None
depends_on: str | None = None


_JOB_TASK_TYPE_VALUES = [
    "MARKET_DATA_SYNC",
    "SECURITY_MASTER_SYNC",
    "LOCAL_COMMAND",
    "HTTP_CALLBACK",
    "ACCOUNT_CLEANUP",
]
_JOB_KIND_VALUES = ["SYSTEM", "NORMAL"]
_JOB_RUN_STATUS_VALUES = ["RUNNING", "SUCCESS", "FAILED"]
_JOB_TRIGGER_SOURCE_VALUES = ["SCHEDULED", "MANUAL"]


def _seed_job(
    name: str,
    task_type: str,
    kind: str,
    enabled: bool,
    cron_expr: str,
    description: str,
) -> None:
    """按 name 幂等插入任务（已存在同名校验由唯一约束兜底，勿重复执行）。"""
    # task_type/kind 为原生枚举列：asyncpg 预编译对裸参数采用 VARCHAR 类型，
    # 插入枚举列会报类型不匹配，故对这两个参数显式 cast 到目标枚举类型。
    op.execute(
        sa.text(
            "INSERT INTO job_configs "
            "(name, task_type, kind, enabled, cron_expr, params, description) "
            "SELECT :name, CAST(:task_type AS \"JobTaskType\"), "
            "CAST(:kind AS \"JobKind\"), :enabled, :cron_expr, NULL, :description "
            "WHERE NOT EXISTS (SELECT 1 FROM job_configs WHERE name = :name)"
        ).bindparams(
            name=name,
            task_type=task_type,
            kind=kind,
            enabled=enabled,
            cron_expr=cron_expr,
            description=description,
        )
    )


def upgrade() -> None:
    bind = op.get_bind()

    # 建 4 个原生 PG 枚举（checkfirst 幂等）
    sa.Enum(*_JOB_TASK_TYPE_VALUES, name="JobTaskType").create(bind, checkfirst=True)
    sa.Enum(*_JOB_KIND_VALUES, name="JobKind").create(bind, checkfirst=True)
    sa.Enum(*_JOB_RUN_STATUS_VALUES, name="JobRunStatus").create(bind, checkfirst=True)
    sa.Enum(*_JOB_TRIGGER_SOURCE_VALUES, name="JobTriggerSource").create(
        bind, checkfirst=True
    )

    # 任务配置表
    op.create_table(
        "job_configs",
        sa.Column("id", sa.String(length=36), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("task_type", postgresql.ENUM(*_JOB_TASK_TYPE_VALUES, name="JobTaskType", create_type=False), nullable=False),
        sa.Column("kind", postgresql.ENUM(*_JOB_KIND_VALUES, name="JobKind", create_type=False), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("cron_expr", sa.String(length=64), nullable=False),
        sa.Column("params", sa.JSON(), nullable=True),
        sa.Column("description", sa.String(length=512), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("name"),
    )

    # 执行日志表
    op.create_table(
        "job_run_logs",
        sa.Column("id", sa.String(length=36), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "job_id",
            sa.String(length=36),
            sa.ForeignKey("job_configs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("status", postgresql.ENUM(*_JOB_RUN_STATUS_VALUES, name="JobRunStatus", create_type=False), nullable=False),
        sa.Column(
            "trigger_source",
            postgresql.ENUM(*_JOB_TRIGGER_SOURCE_VALUES, name="JobTriggerSource", create_type=False),
            nullable=False,
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("message", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    # 种子：系统任务（账户清理，默认开启）+ 普通任务示例（默认关闭）
    _seed_job(
        name="每日账户清理",
        task_type="ACCOUNT_CLEANUP",
        kind="SYSTEM",
        enabled=True,
        cron_expr="0 4 * * *",
        description="物理清理已过保留期的软删除账户（系统任务，仅可编辑）。",
    )
    _seed_job(
        name="收盘后行情同步",
        task_type="MARKET_DATA_SYNC",
        kind="NORMAL",
        enabled=False,
        cron_expr="0 16 * * 1-5",
        description="工作日 16:00 遍历全部组合同步实时行情并重建快照/净值。",
    )
    _seed_job(
        name="证券主数据同步",
        task_type="SECURITY_MASTER_SYNC",
        kind="NORMAL",
        enabled=False,
        cron_expr="0 3 * * 1-5",
        description="配置文件驱动同步系统级证券主数据（MASTER_LIST 接口）。",
    )


def downgrade() -> None:
    bind = op.get_bind()
    op.drop_table("job_run_logs")
    op.drop_table("job_configs")
    sa.Enum(*_JOB_TRIGGER_SOURCE_VALUES, name="JobTriggerSource").drop(bind, checkfirst=True)
    sa.Enum(*_JOB_RUN_STATUS_VALUES, name="JobRunStatus").drop(bind, checkfirst=True)
    sa.Enum(*_JOB_KIND_VALUES, name="JobKind").drop(bind, checkfirst=True)
    sa.Enum(*_JOB_TASK_TYPE_VALUES, name="JobTaskType").drop(bind, checkfirst=True)