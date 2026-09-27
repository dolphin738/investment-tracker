"""孤儿 RUNNING 日志修复 — QA 补充验证（边界 / 混合批次 / 异常吞没 / 锁释放 穿刺性断言）。

- ``test_start_scheduler_reaps_even_when_scheduler_disabled``：守卫「回收**先于**
  ``SCHEDULER_ENABLED`` 判定」。把 ``await reap_orphan_run_logs()`` 移到开关判定之后，
  既有 6 条测试**全部仍然通过**（测试环境开关恒为 True），只有本条会失败。
- 宽限期边界（冻结时钟精确判定）、混合批次只回收孤儿、零孤儿不发 UPDATE、
  回收器自身故障吞异常返回 0、协程取消后 per-job 锁确实释放、reaper 模块被测试库重绑覆盖。

``test_per_job_granularity_shields_stale_row_of_running_job`` 为**行为刻画测试**
（记录「锁以 job 为粒度」这一已知边界，改动后即报警）；末条
``test_mis_marked_row_clears_orphan_error_after_success_run`` 已随 runner 成功路径
清理 error 由刻画转为回归断言。
"""
from __future__ import annotations

import asyncio
import contextlib
import itertools
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

import app.db.database as dbmod
from app.models import JobRunLog
from app.models.enums import JobKind, JobRunStatus, JobTaskType, JobTriggerSource
from app.models.job import JobConfig
from app.services.scheduler import _running_job_ids
from app.services.scheduler import handlers as handlers_mod
from app.services.scheduler import lifecycle as lifecycle_mod
from app.services.scheduler import reaper as reaper_mod
from app.services.scheduler import runner as runner_mod
from app.services.scheduler.reaper import reap_orphan_run_logs
from tests._scheduler_reap_fakes import _ExplodingSession, _FrozenDateTime

pytestmark = pytest.mark.asyncio
_seq = itertools.count()


async def _new_task() -> JobConfig:
    """建一个 disabled 的普通任务（不参与 cron 注册，仅供日志外键）。"""
    async with dbmod.AsyncSessionLocal() as s:
        cfg = JobConfig(
            name=f"QA-{next(_seq)}",
            kind=JobKind.NORMAL,
            task_type=JobTaskType.HTTP_CALLBACK,
            cron_expr="0 3 * * *",
            enabled=False,
            params={"url": "https://example.com/hook"},
        )
        s.add(cfg)
        await s.commit()
        return cfg


async def _new_log(cfg: JobConfig, status: JobRunStatus, started_at: datetime) -> JobRunLog:
    async with dbmod.AsyncSessionLocal() as s:
        log = JobRunLog(
            job_id=cfg.id,
            status=status,
            trigger_source=JobTriggerSource.SCHEDULED,
            started_at=started_at,
        )
        s.add(log)
        await s.commit()
        return log


async def _get_log(log_id: str) -> JobRunLog:
    async with dbmod.AsyncSessionLocal() as s:
        return (
            await s.execute(select(JobRunLog).where(JobRunLog.id == log_id))
        ).scalar_one()


def _patch_settings(monkeypatch, *, enabled: bool) -> None:
    """钉死 SCHEDULER_ENABLED，避免依赖 .env 偶值。"""

    class _S:
        SCHEDULER_ENABLED = enabled

    monkeypatch.setattr(lifecycle_mod, "get_settings", lambda: _S())


@contextlib.contextmanager
def _frozen_clock(monkeypatch, moment: datetime):
    """冻结 reaper 时钟（PG timestamptz 精度到微秒，故边界可精确判定）。"""
    _FrozenDateTime._frozen = moment
    monkeypatch.setattr(reaper_mod, "datetime", _FrozenDateTime)
    try:
        yield moment
    finally:
        _FrozenDateTime._frozen = None


async def test_reaper_module_sessionmaker_is_rebound_to_test_db(_isolate_module_sessionmakers):
    """``reaper`` 的模块级别名必须指向测试库 maker，且重绑扫描确实覆盖到它。"""
    from tests._sessionmaker_isolation import rebind_sessionmakers, restore_sessionmakers

    test_db = dbmod.settings.TEST_DATABASE_URL.rstrip("/").split("/")[-1]
    maker = dbmod.AsyncSessionLocal
    assert reaper_mod.AsyncSessionLocal is maker
    bound_db = reaper_mod.AsyncSessionLocal.kw["bind"].url.database
    assert bound_db == test_db, f"reaper 绑定到了非测试库：{bound_db}"

    original, sentinel = reaper_mod.AsyncSessionLocal, object()
    reaper_mod.AsyncSessionLocal = sentinel
    try:
        changes = rebind_sessionmakers(maker)
        rebounded = {getattr(m, "__name__", repr(m)) for m, _ in changes}
        assert "app.services.scheduler.reaper" in rebounded, (
            f"重绑扫描未覆盖 reaper → 它会静默写开发库；实际覆盖：{sorted(rebounded)}"
        )
        assert reaper_mod.AsyncSessionLocal is maker
        restore_sessionmakers(changes)
        assert reaper_mod.AsyncSessionLocal is sentinel
    finally:
        reaper_mod.AsyncSessionLocal = original


async def test_grace_boundary_started_at_exactly_at_cutoff_is_not_reaped(monkeypatch):
    """``started_at == now - grace`` 恰落在 cutoff 上 → 判定是严格 ``<`` → 不回收。"""
    moment = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
    cfg = await _new_task()
    log = await _new_log(cfg, JobRunStatus.RUNNING, moment - timedelta(seconds=300))

    with _frozen_clock(monkeypatch, moment):
        reaped = await reap_orphan_run_logs(grace_seconds=300)

    assert reaped == 0
    after = await _get_log(log.id)
    assert after.status == JobRunStatus.RUNNING
    assert after.finished_at is None


async def test_grace_boundary_one_microsecond_past_cutoff_is_reaped(monkeypatch):
    """早 1 微秒越过边界即回收（证明判定精确到微秒，不存在「多等一轮」）。"""
    moment = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
    cfg = await _new_task()
    log = await _new_log(cfg, JobRunStatus.RUNNING, moment - timedelta(seconds=300, microseconds=1))

    with _frozen_clock(monkeypatch, moment):
        reaped = await reap_orphan_run_logs(grace_seconds=300)

    assert reaped == 1
    after = await _get_log(log.id)
    assert after.status == JobRunStatus.FAILED
    assert after.finished_at == moment


async def test_mixed_batch_reaps_only_orphans_and_leaves_others_intact():
    """四类行同批：只回收「超宽限期 + 不在运行锁」的孤儿，其余 finished_at/error 都不许被碰。"""
    now = datetime.now(timezone.utc)
    cfg_a, cfg_b = await _new_task(), await _new_task()
    cfg_c, cfg_d = await _new_task(), await _new_task()
    orphan_2h = await _new_log(cfg_a, JobRunStatus.RUNNING, now - timedelta(hours=2))
    orphan_3d = await _new_log(cfg_a, JobRunStatus.RUNNING, now - timedelta(days=3))
    live_10h = await _new_log(cfg_b, JobRunStatus.RUNNING, now - timedelta(hours=10))
    terminal_ok = await _new_log(cfg_c, JobRunStatus.SUCCESS, now - timedelta(days=5))
    terminal_bad = await _new_log(cfg_c, JobRunStatus.FAILED, now - timedelta(days=5))
    fresh = await _new_log(cfg_d, JobRunStatus.RUNNING, now - timedelta(seconds=5))

    _running_job_ids.add(cfg_b.id)  # 本进程正在跑（模拟 10 小时 scan）
    try:
        reaped = await reap_orphan_run_logs(grace_seconds=300)
    finally:
        _running_job_ids.discard(cfg_b.id)

    assert reaped == 2, "只应回收 cfg_a 的两条孤儿（同一 job 的多行按行计）"
    for row in (orphan_2h, orphan_3d):
        got = await _get_log(row.id)
        assert got.status == JobRunStatus.FAILED
        assert got.finished_at is not None
        assert "中断" in (got.error or "")
    live = await _get_log(live_10h.id)
    assert (live.status, live.finished_at, live.error) == (JobRunStatus.RUNNING, None, None)
    assert (await _get_log(terminal_ok.id)).status == JobRunStatus.SUCCESS
    assert (await _get_log(terminal_bad.id)).status == JobRunStatus.FAILED
    assert (await _get_log(fresh.id)).status == JobRunStatus.RUNNING


async def test_per_job_granularity_shields_stale_row_of_running_job():
    """【已知边界】锁以 job 为粒度：同一 job 的旧孤儿行会被在跑的执行一并豁免，本次不回收。"""
    cfg = await _new_task()
    stale = await _new_log(
        cfg, JobRunStatus.RUNNING, datetime.now(timezone.utc) - timedelta(days=1)
    )
    _running_job_ids.add(cfg.id)
    try:
        reaped = await reap_orphan_run_logs(grace_seconds=60)
    finally:
        _running_job_ids.discard(cfg.id)

    assert reaped == 0
    assert (await _get_log(stale.id)).status == JobRunStatus.RUNNING


async def test_no_orphan_returns_zero_and_issues_no_update(monkeypatch):
    """零孤儿必须返回 0 且一条 UPDATE 都不发（回收器不得成为常写负担）。"""
    updates: list[object] = []
    real_update = reaper_mod.update
    monkeypatch.setattr(
        reaper_mod, "update", lambda *a, **k: updates.append(a) or real_update(*a, **k)
    )

    assert await reap_orphan_run_logs(grace_seconds=0) == 0  # 库里没有任何日志
    now = datetime.now(timezone.utc)
    cfg = await _new_task()
    await _new_log(cfg, JobRunStatus.RUNNING, now - timedelta(seconds=1))
    terminal = await _new_task()
    await _new_log(terminal, JobRunStatus.SUCCESS, now - timedelta(days=9))
    assert await reap_orphan_run_logs(grace_seconds=300) == 0
    assert updates == [], f"零孤儿时不得发起 UPDATE，实际 {len(updates)} 次"


def _boom_factory(exc: Exception):
    """返回一个「调用即抛」的 ``AsyncSessionLocal`` 替身（模拟库不可达）。"""

    def _raise(*a, **k):
        raise exc

    return _raise


async def test_reap_swallows_session_error_and_returns_zero(monkeypatch):
    """会话都建不起来 → 吞异常、返回 0、绝不向上抛。"""
    cfg = await _new_task()
    await _new_log(
        cfg, JobRunStatus.RUNNING, datetime.now(timezone.utc) - timedelta(hours=1)
    )
    monkeypatch.setattr(
        reaper_mod, "AsyncSessionLocal", _boom_factory(RuntimeError("db unreachable"))
    )
    assert await reap_orphan_run_logs() == 0


async def test_reap_swallows_commit_failure_and_leaves_row_untouched(monkeypatch):
    """commit 失败 → 返回 0 且行保持 RUNNING（不得半成品地写入 finished_at）。"""
    cfg = await _new_task()
    log = await _new_log(
        cfg, JobRunStatus.RUNNING, datetime.now(timezone.utc) - timedelta(hours=1)
    )
    real_factory = reaper_mod.AsyncSessionLocal
    monkeypatch.setattr(
        reaper_mod, "AsyncSessionLocal", lambda: _ExplodingSession(real_factory())
    )

    assert await reap_orphan_run_logs(grace_seconds=60) == 0
    after = await _get_log(log.id)
    assert after.status == JobRunStatus.RUNNING
    assert after.finished_at is None


async def test_start_scheduler_survives_reaper_failure(monkeypatch):
    """回收器整体失败不得阻塞启动：``start_scheduler`` 正常返回且调度器照常建立。"""
    monkeypatch.setattr(
        reaper_mod, "AsyncSessionLocal", _boom_factory(RuntimeError("db down"))
    )
    _patch_settings(monkeypatch, enabled=True)
    try:
        await lifecycle_mod.start_scheduler()
        assert lifecycle_mod._state._scheduler is not None, "回收失败不应阻塞注册"
    finally:
        lifecycle_mod.shutdown_scheduler()


async def test_start_scheduler_reaps_even_when_scheduler_disabled(monkeypatch):
    """``SCHEDULER_ENABLED=false`` 时仍要回收（既有 6 条守不住：其环境开关恒为 True）。"""
    _patch_settings(monkeypatch, enabled=False)
    cfg = await _new_task()
    log = await _new_log(
        cfg, JobRunStatus.RUNNING, datetime.now(timezone.utc) - timedelta(hours=1)
    )
    lifecycle_mod.shutdown_scheduler()  # 确保干净起点
    try:
        await lifecycle_mod.start_scheduler()
    finally:
        lifecycle_mod.shutdown_scheduler()

    after = await _get_log(log.id)
    assert after.status == JobRunStatus.FAILED
    assert after.finished_at is not None
    assert lifecycle_mod._state._scheduler is None, "开关关闭时不应创建调度器"


async def test_cancelled_run_releases_per_job_lock_and_can_run_again():
    """取消路径走外层持锁的 ``_run_job``：CancelledError 上抛后锁必须释放且能立即再跑。"""
    original = handlers_mod._HANDLERS[JobTaskType.HTTP_CALLBACK]
    cfg = await _new_task()
    assert cfg.id not in _running_job_ids

    async def _boom(job_cfg: JobConfig) -> str:
        raise asyncio.CancelledError()

    handlers_mod._HANDLERS[JobTaskType.HTTP_CALLBACK] = _boom
    try:
        with pytest.raises(asyncio.CancelledError):
            await runner_mod._run_job(cfg.id, JobTriggerSource.MANUAL)
        assert cfg.id not in _running_job_ids, "取消后锁泄漏 → 该 job 永久无法再触发"
    finally:
        handlers_mod._HANDLERS[JobTaskType.HTTP_CALLBACK] = original

    async def _ok(job_cfg: JobConfig) -> str:
        return "done"

    handlers_mod._HANDLERS[JobTaskType.HTTP_CALLBACK] = _ok
    try:
        await runner_mod._run_job(cfg.id, JobTriggerSource.MANUAL)  # 锁已释放 ⇒ 不被去重挡掉
    finally:
        handlers_mod._HANDLERS[JobTaskType.HTTP_CALLBACK] = original
        _running_job_ids.discard(cfg.id)

    async with dbmod.AsyncSessionLocal() as s:
        rows = (
            await s.execute(
                select(JobRunLog)
                .where(JobRunLog.job_id == cfg.id)
                .order_by(JobRunLog.started_at.asc(), JobRunLog.created_at.asc())
            )
        ).scalars().all()
    assert [r.status for r in rows] == [JobRunStatus.FAILED, JobRunStatus.SUCCESS]
    assert "取消" in (rows[0].error or "")


async def test_mis_marked_row_clears_orphan_error_after_success_run():
    """被误标 FAILED 的行跑完后改回 SUCCESS，且 ``error`` 被成功路径清空。

    回归（runner.py 成功分支置 ``log.error = None``）：回收器已给该行打过「执行中断」
    文案时，若成功路径不清 error，日志会以 SUCCESS 状态长期挂着一条中断文案、
    在管理端执行日志里误导运维。故自愈必须连文案一起自愈。
    """
    original = handlers_mod._HANDLERS[JobTaskType.HTTP_CALLBACK]
    cfg, gate = await _new_task(), asyncio.Event()

    async def _slow(job_cfg: JobConfig) -> str:
        await gate.wait()
        return "ok"

    handlers_mod._HANDLERS[JobTaskType.HTTP_CALLBACK] = _slow
    row_id = None
    task = asyncio.create_task(runner_mod._run_job(cfg.id, JobTriggerSource.MANUAL))
    try:
        for _ in range(250):  # 等 RUNNING 行落库（runner 先 commit 再跑 handler）
            async with dbmod.AsyncSessionLocal() as s:
                q = select(JobRunLog.id, JobRunLog.status).where(JobRunLog.job_id == cfg.id)
                row = (await s.execute(q)).first()
            if row is not None and row.status == JobRunStatus.RUNNING:
                row_id = row.id
                break
            await asyncio.sleep(0.02)
        assert row_id is not None, "RUNNING 行迟迟未落库"

        saved = set(_running_job_ids)  # 模拟**另一 worker**视角（其锁集合为空）的误回收
        _running_job_ids.clear()
        try:
            assert await reap_orphan_run_logs(grace_seconds=0) == 1
        finally:
            _running_job_ids.update(saved)

        gate.set()
        await task
    finally:
        handlers_mod._HANDLERS[JobTaskType.HTTP_CALLBACK] = original
        gate.set()
        with contextlib.suppress(Exception):
            await task
        _running_job_ids.discard(cfg.id)

    after = await _get_log(row_id)
    assert after.status == JobRunStatus.SUCCESS  # 自愈：真执行结束时改回 SUCCESS
    assert after.finished_at is not None
    assert after.error is None, "自愈必须连文案一起自愈：成功路径需清空回收器写入的 error"
    assert after.message == "ok"
