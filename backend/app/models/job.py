"""定时任务模型 — DB 驱动的统一调度器（APScheduler AsyncIOScheduler）。

两种既有定任务实现统一为数据库驱动：
- 行情同步（原 scheduler.py 的 APScheduler 任务）→ 迁入 ``job_configs`` 普通任务。
- 账户清理（原 external cron 调 /api/internal/cleanup）→ 迁入 ``job_configs`` 系统任务。

- ``JobConfig``：任务配置，``kind=SYSTEM`` 的系统任务仅可编辑不可删除，
  ``kind=NORMAL`` 的普通任务可增删改，均由 admin 定时任务管理页维护。
- ``JobRunLog``：单次执行日志（触发来源 / 状态 / 起止时间 / 错误）。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    Text,
    false,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, CreatedAtMixin, TimestampMixin, pk_uuid
from app.models.enums import JobKind, JobRunStatus, JobTaskType, JobTriggerSource


class JobConfig(Base, TimestampMixin):
    __tablename__ = "job_configs"

    id: Mapped[str] = pk_uuid()
    name: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    task_type: Mapped[JobTaskType] = mapped_column(
        Enum(JobTaskType, name="JobTaskType", native_enum=True, create_type=False),
        nullable=False,
    )
    kind: Mapped[JobKind] = mapped_column(
        Enum(JobKind, name="JobKind", native_enum=True, create_type=False),
        nullable=False,
    )
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
    # 5 字段 cron 表达式（分 时 日 月 周），APScheduler`CronTrigger.from_crontab`
    cron_expr: Mapped[str] = mapped_column(String(64), nullable=False)
    # 任务类型相关的可选参数（如 LOCAL_COMMAND.command / HTTP_CALLBACK.url）
    params: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    description: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # 保留执行日志条数上限：NULL/<=0 表示不限制；有值时删除该任务超出的最旧日志
    max_logs: Mapped[int | None] = mapped_column(Integer, nullable=True)


class JobRunLog(Base, CreatedAtMixin):
    __tablename__ = "job_run_logs"

    id: Mapped[str] = pk_uuid()
    job_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("job_configs.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[JobRunStatus] = mapped_column(
        Enum(JobRunStatus, name="JobRunStatus", native_enum=True, create_type=False),
        nullable=False,
    )
    trigger_source: Mapped[JobTriggerSource] = mapped_column(
        Enum(
            JobTriggerSource,
            name="JobTriggerSource",
            native_enum=True,
            create_type=False,
        ),
        nullable=False,
    )
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        server_default=func.now(),
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)