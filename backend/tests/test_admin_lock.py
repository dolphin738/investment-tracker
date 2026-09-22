"""app.services.admin_lock 单测：跨进程互斥锁（DB 行级 + TTL）。

覆盖（多进程单飞缺口补强）：
1. 首次获取成功（行不存在 → INSERT 分支）
2. 未释放再获取失败（他人持有且未过 TTL → 获取失败，且不改写持有者）
3. 释放后可再获取
4. 错误令牌释放无效（「谁持有谁释放」）
5. 陈旧锁（持锁进程崩溃来不及释放）超过 TTL 后可被抢占
6. TTL 参数生效（ttl_hours=0 时同一锁可被立即抢占）

每个用例开头清表：避免用例间相互污染（不依赖 conftest 是否回滚）。
"""
from __future__ import annotations

import pytest
from sqlalchemy import text

from app.services.admin_lock import (
    LOCK_DIVIDEND_SEED,
    acquire_admin_lock,
    is_cancel_requested,
    release_admin_lock,
    request_cancel,
)


async def _reset(session) -> None:
    await session.execute(text("DELETE FROM admin_locks"))
    await session.commit()


async def _row(session, name: str = LOCK_DIVIDEND_SEED):
    res = await session.execute(
        text("SELECT owner, acquired_at FROM admin_locks WHERE name = :n"),
        {"n": name},
    )
    return res.first()


@pytest.mark.asyncio
async def test_acquire_first_time_succeeds(session):
    """① 行不存在 → INSERT 成功 → 获得锁，行内 owner 为令牌。"""
    await _reset(session)
    tok = await acquire_admin_lock(session, LOCK_DIVIDEND_SEED)
    assert tok is not None
    row = await _row(session)
    assert row is not None
    assert row[0] == tok
    assert row[1] is not None, "获取时须写入 acquired_at（TTL 判据依赖它）"


@pytest.mark.asyncio
async def test_acquire_twice_without_release_fails(session):
    """② 核心：他人持有且未过期 → 获取失败（None），且不得改写持有者。"""
    await _reset(session)
    first = await acquire_admin_lock(session, LOCK_DIVIDEND_SEED)
    assert first is not None

    second = await acquire_admin_lock(session, LOCK_DIVIDEND_SEED)
    assert second is None, "被占用时须返回 None（调用方据此返 409）"

    row = await _row(session)
    assert row[0] == first, "失败的获取不得改写持有者 / 获取时刻"


@pytest.mark.asyncio
async def test_release_then_acquire_succeeds(session):
    """③ 释放 → 行回到空闲（owner/acquired_at 均 NULL）→ 可再次获取。"""
    await _reset(session)
    tok = await acquire_admin_lock(session, LOCK_DIVIDEND_SEED)
    await release_admin_lock(session, LOCK_DIVIDEND_SEED, tok)

    row = await _row(session)
    assert row[0] is None and row[1] is None, "释放后须回到空闲态"

    again = await acquire_admin_lock(session, LOCK_DIVIDEND_SEED)
    assert again is not None and again != tok


@pytest.mark.asyncio
async def test_release_with_wrong_token_is_noop(session):
    """④ 非持有者的释放须无效（谁持有谁释放），锁仍被占用。"""
    await _reset(session)
    tok = await acquire_admin_lock(session, LOCK_DIVIDEND_SEED)

    await release_admin_lock(session, LOCK_DIVIDEND_SEED, "not-the-owner")
    row = await _row(session)
    assert row[0] == tok, "错误令牌不得释放他人持有的锁"
    assert await acquire_admin_lock(session, LOCK_DIVIDEND_SEED) is None


@pytest.mark.asyncio
async def test_stale_lock_preempted_after_ttl(session):
    """⑤ 持锁进程崩溃（来不及释放）→ 超过 TTL 后被抢占，避免锁永久残留锁死功能。"""
    await _reset(session)
    tok = await acquire_admin_lock(session, LOCK_DIVIDEND_SEED)
    # 回拨获取时刻到远超 TTL（26h）之前，模拟陈旧锁
    await session.execute(
        text(
            "UPDATE admin_locks SET acquired_at = now() - make_interval(hours => 100)"
            " WHERE name = :n"
        ),
        {"n": LOCK_DIVIDEND_SEED},
    )
    await session.commit()

    new_tok = await acquire_admin_lock(session, LOCK_DIVIDEND_SEED)
    assert new_tok is not None, "陈旧锁须可被抢占"
    assert new_tok != tok
    row = await _row(session)
    assert row[0] == new_tok


@pytest.mark.asyncio
async def test_ttl_param_zero_allows_immediate_preempt(session):
    """⑥ ttl_hours 参数生效：TTL=0 意味着「任何既有锁都算陈旧」→ 可立即抢占。"""
    await _reset(session)
    await acquire_admin_lock(session, LOCK_DIVIDEND_SEED)
    # 默认 TTL 下不可抢占
    assert await acquire_admin_lock(session, LOCK_DIVIDEND_SEED) is None
    # TTL=0 → 立即抢占
    assert await acquire_admin_lock(session, LOCK_DIVIDEND_SEED, ttl_hours=0) is not None


@pytest.mark.asyncio
async def test_request_cancel_requires_a_holder(session):
    """⑦ 无人持锁时请求取消 → False（调用方据此返 409），且不写入标记。"""
    await _reset(session)
    assert await request_cancel(session, LOCK_DIVIDEND_SEED) is False
    assert await is_cancel_requested(session, LOCK_DIVIDEND_SEED) is False


@pytest.mark.asyncio
async def test_request_cancel_sets_marker_and_release_clears_it(session):
    """⑧ 有人持锁 → True 且标记置位；释放锁须**一并清标记**（防泄漏到下一次运行）。"""
    await _reset(session)
    tok = await acquire_admin_lock(session, LOCK_DIVIDEND_SEED)

    assert await request_cancel(session, LOCK_DIVIDEND_SEED) is True
    assert await is_cancel_requested(session, LOCK_DIVIDEND_SEED) is True

    await release_admin_lock(session, LOCK_DIVIDEND_SEED, tok)
    assert (
        await is_cancel_requested(session, LOCK_DIVIDEND_SEED) is False
    ), "释放锁须清空取消标记，否则下次播种一启动就在检查点自行退出"
