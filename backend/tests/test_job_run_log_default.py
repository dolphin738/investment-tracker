"""JobRunLog.started_at Python 侧默认值回归（阶段4 Lint 闸门捕获的潜在 Bug）。

job.py 的 `default=lambda: datetime.now(timezone.utc)`（started_at 列）引用了
未导入的 `timezone`（模块原仅 `from datetime import datetime`）→ 调度器每次
执行任务写运行日志（`app/core/scheduler.py:205` 构造 `JobRunLog(...)`）时，
INSERT 求值该 lambda 触发 ``NameError: name 'timezone' is not defined``，
任务执行日志整体不可写。测试此前只查日志端点、从未真实 INSERT JobRunLog，
故全量 pytest 349 绿也未暴露。修复：补 `timezone` 导入。

回归：不设 started_at 直接 INSERT 一条 JobRunLog，断言 Python 侧默认值生效。
"""

from __future__ import annotations

import pytest

import app.db.database as dbmod
from app.models import JobRunLog
from app.models.enums import JobKind, JobRunStatus, JobTaskType, JobTriggerSource
from app.models.job import JobConfig

pytestmark = pytest.mark.asyncio


async def test_job_run_log_started_at_python_default(client):
    """INSERT JobRunLog 不显式传 started_at → default lambda 正常求值。"""
    async with dbmod.AsyncSessionLocal() as s:
        cfg = JobConfig(
            name="runlog-default-probe",
            kind=JobKind.NORMAL,
            task_type=JobTaskType.HTTP_CALLBACK,
            cron_expr="0 3 * * *",
            enabled=False,
            params={"url": "https://example.com/hook"},
        )
        s.add(cfg)
        await s.flush()

        log = JobRunLog(
            job_id=cfg.id,
            status=JobRunStatus.RUNNING,
            trigger_source=JobTriggerSource.MANUAL,
        )
        s.add(log)
        # 修复前：flush 触发 INSERT 求值 default lambda →
        # NameError: name 'timezone' is not defined
        await s.flush()
        await s.rollback()  # 不留数据（_clean_db 也会 TRUNCATE，双保险）

    assert log.started_at is not None
