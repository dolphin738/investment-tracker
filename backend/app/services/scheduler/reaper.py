"""启动期「孤儿 RUNNING 执行日志」回收。

**缺陷与根因（本次修复目标）**

``runner._run_job_inner`` 的执行日志状态机是「先写 RUNNING 并提交
（``runner.py`` 构造 ``JobRunLog(status=RUNNING)`` → commit），跑完再回填
SUCCESS/FAILED 并二次提交」。两次提交之间没有 DB 侧的「运行中」可观测标记：
只要进程在这段窗口内**被强杀 / 重启 / 容器重部署**（或协程被取消，见
``runner.py`` 对 ``asyncio.CancelledError`` 的补记），那一行 RUNNING 就**永远
停在 RUNNING**——没有 finished_at、没有终态，管理端「执行日志」里表现为一条
长期「执行中」的记录，即使任务本身早已 ``enabled=false`` 也不再有任何协程会去收敛它。

修复：应用启动时把「本进程已无对应运行中任务」的孤儿 RUNNING 行收敛为 FAILED，
并写清原因，使状态机闭环。

**为什么不误杀当前进程真正在跑的任务**

``_state._running_job_ids`` 是 per-job 运行锁集合（cron 与手动触发共用，
``runner._run_job`` 进出各维护一次）；其中出现的 job_id 一律跳过回收。
叠加宽限期（``grace_seconds``）兜住「启动瞬间另一进程/尚未登记的运行」。
长耗时任务（如 DIVIDEND_NOTICE_SCAN 全量约 10 小时）的 started_at 早已超过
宽限期，**只靠宽限期会误杀**，故必须以运行锁为准、宽限期只作次级保险。

**误杀的代价是可自愈的**：即使极端并发下误标 FAILED，真正仍在跑的执行在结束时
会用自己持有的 ORM 实例把该行改回 SUCCESS（``runner.py`` 末段 commit），
不会造成数据损坏，只是一条中间态文案。
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update

from app.db.database import AsyncSessionLocal
from app.models import JobRunLog
from app.models.enums import JobRunStatus

from ._state import _running_job_ids

logger = logging.getLogger(__name__)

# 孤儿判定宽限期（秒）：只回收 started_at 早于 ``now - grace`` 的 RUNNING 行。
# 用途仅为「刚启动、另一进程可能仍在跑」的竞态保险；本进程在跑的任务由运行锁直接排除。
_DEFAULT_ORPHAN_GRACE_SECONDS = 300

# 回收原因文案：写进 JobRunLog.error，管理端执行日志可直接读到。
_ORPHAN_ERROR = (
    "执行中断：应用重启/进程退出时该次执行仍在 RUNNING，"
    "已由启动期孤儿回收标记为失败（非任务本身报错）"
)


async def reap_orphan_run_logs(grace_seconds: int = _DEFAULT_ORPHAN_GRACE_SECONDS) -> int:
    """把孤儿 RUNNING 执行日志收敛为 FAILED，返回实际回收行数。

    判定口径（两条同时成立才回收）：
    1. ``status = RUNNING`` 且 ``finished_at IS NULL`` 且 ``started_at`` 早于宽限期；
    2. 该 ``job_id`` **不在**本进程 per-job 运行锁集合 ``_running_job_ids`` 中。

    回收动作：置 ``status=FAILED`` / ``finished_at=now`` / ``error=回收原因``。

    本函数**吞掉全部异常并记日志**：启动期的自愈动作绝不能反过来阻塞应用启动
    （如库暂不可达、迁移落后导致缺列等场景）。
    """
    try:
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(seconds=max(int(grace_seconds), 0))
        async with AsyncSessionLocal() as session:
            rows = (
                await session.execute(
                    select(JobRunLog.id, JobRunLog.job_id)
                    .where(JobRunLog.status == JobRunStatus.RUNNING)
                    .where(JobRunLog.finished_at.is_(None))
                    .where(JobRunLog.started_at < cutoff)
                )
            ).all()
            # 运行锁在**更新前**再取一次快照：SELECT 与 UPDATE 之间可能已有新执行登记。
            running = set(_running_job_ids)
            stale_ids = [row.id for row in rows if row.job_id not in running]
            if not stale_ids:
                return 0
            await session.execute(
                update(JobRunLog)
                .where(JobRunLog.id.in_(stale_ids))
                .values(
                    status=JobRunStatus.FAILED,
                    finished_at=now,
                    error=_ORPHAN_ERROR,
                )
            )
            await session.commit()
        logger.warning(
            "启动期回收 %d 条孤儿 RUNNING 执行日志（job_run_logs），判定宽限期 %ds",
            len(stale_ids),
            max(int(grace_seconds), 0),
        )
        return len(stale_ids)
    except Exception:
        # 自愈动作失败不得阻塞启动：只记日志，交由下次启动重试。
        logger.exception("孤儿 RUNNING 执行日志回收失败（不影响应用启动）")
        return 0
