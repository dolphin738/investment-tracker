"""跨进程管理端动作互斥锁（DB 行级，带 TTL）。

背景：进程内 ``asyncio.Lock`` 只在单 worker 内有效；多 worker / 多副本部署下，各进程
各自的事件循环各持一个 Lock，连点会**各自**启动一个长耗时任务（历史分红播种约 10 小时）
并打满接口 ``rate_limit=10/min`` 预算。本模块以数据库行（``admin_locks``）作为跨进程
共享的互斥标记，与进程内 Lock 组成两层：进程内 Lock 拦同进程连点（零 DB 往返），
DB 锁拦跨进程并发。

**获取（acquire）是单条原子语句**::

    INSERT INTO admin_locks (name, owner, acquired_at)
    VALUES (:name, :tok, now())
    ON CONFLICT (name) DO UPDATE
       SET owner = :tok, acquired_at = now()
     WHERE admin_locks.owner IS NULL
        OR admin_locks.acquired_at < now() - make_interval(hours => :ttl_hours)
    RETURNING owner;

- 行不存在                  → INSERT 成功        → RETURNING 有行 → 获得锁；
- 行存在且空闲 / 已过 TTL   → DO UPDATE 生效     → RETURNING 有行 → 获得锁（抢占陈旧锁）；
- 行存在且被他人持有未过期  → WHERE 不满足       → RETURNING 0 行 → 获取失败。

单语句由 PG 的 unique 冲突处理保证原子：**不存在「先 SELECT 再 UPDATE」的时间窗**，
故无需显式行锁或调整隔离级别。TTL 用于持锁进程崩溃 / 被强杀（来不及释放）的场景，
让后续触发者能在若干小时后自动接管，避免锁永久残留把功能锁死。

**释放（release）仅当 owner 匹配**：``WHERE name = :name AND owner = :tok``，
保证「谁持有谁释放」——A 崩溃留下的陈旧锁不会被 B 误释放，B 走的是 TTL 抢占路径。
"""
from __future__ import annotations

import logging
import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

# 锁的陈旧判据（小时）：须显著大于任务最长耗时（历史分红播种约 10h），
# 留一倍以上余量，防止「任务还在跑就被判陈旧、被他人抢占」。
ADMIN_LOCK_TTL_HOURS = 26

# 历史分红播种（§5.7）的锁名
LOCK_DIVIDEND_SEED = "dividend_seed"


async def acquire_admin_lock(
    session: AsyncSession, name: str, ttl_hours: int = ADMIN_LOCK_TTL_HOURS
) -> str | None:
    """尝试获取跨进程锁；成功返回持锁令牌，已被占用返回 ``None``。

    调用方须在任务结束（正常 / 抛错 / 取消）时以该令牌调 ``release_admin_lock``。
    """
    token = str(uuid.uuid4())
    res = await session.execute(
        text(
            """
            INSERT INTO admin_locks (name, owner, acquired_at)
            VALUES (:name, :tok, now())
            ON CONFLICT (name) DO UPDATE
               SET owner = :tok, acquired_at = now()
             WHERE admin_locks.owner IS NULL
                OR admin_locks.acquired_at < now() - make_interval(hours => :ttl_hours)
            RETURNING owner
            """
        ),
        {"name": name, "tok": token, "ttl_hours": ttl_hours},
    )
    got = res.first() is not None
    await session.commit()
    if not got:
        logger.info("跨进程锁被占用，本次获取失败：name=%s", name)
        return None
    return token


async def release_admin_lock(session: AsyncSession, name: str, token: str) -> None:
    """释放锁（仅当 ``owner`` 与令牌匹配——「谁持有谁释放」）。

    释放时**一并清空取消标记**：否则本次运行的取消标记会残留到下一次运行，
    导致下次播种一启动就在检查点自行退出。
    """
    await session.execute(
        text(
            """
            UPDATE admin_locks
               SET owner = NULL, acquired_at = NULL, cancel_requested_at = NULL
             WHERE name = :name AND owner = :tok
            """
        ),
        {"name": name, "tok": token},
    )
    await session.commit()


async def request_cancel(session: AsyncSession, name: str) -> bool:
    """请求取消（跨进程信号）：置 ``cancel_requested_at``，返回是否真有运行中的持锁者。

    仅当 ``owner IS NOT NULL``（有人持锁 = 有任务在跑）才置标记并返回 ``True``；
    无人持锁时返回 ``False``（调用方据此返 409「当前没有正在运行的任务」）。

    **不直接杀任务**：本模块不持有其他进程的协程引用，也无法强杀线程；只是留一个
    跨进程可见的标记，由持锁 worker 的循环在下一个检查点自检后自行退出。
    """
    res = await session.execute(
        text(
            """
            UPDATE admin_locks
               SET cancel_requested_at = now()
             WHERE name = :name AND owner IS NOT NULL
            """
        ),
        {"name": name},
    )
    affected = res.rowcount or 0
    await session.commit()
    if affected == 0:
        logger.info("请求取消但无人持锁（无运行中任务）：name=%s", name)
        return False
    return True


async def is_cancel_requested(session: AsyncSession, name: str) -> bool:
    """持锁 worker 侧自检：是否已有人请求取消（跨进程可见）。"""
    res = await session.execute(
        text("SELECT cancel_requested_at FROM admin_locks WHERE name = :n"),
        {"n": name},
    )
    row = res.first()
    return row is not None and row[0] is not None
