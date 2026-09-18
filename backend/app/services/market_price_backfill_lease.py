"""回补执行租约 + 世代标记（协作式取消）——迁移 0024 的运行时机制。

自 ``market_daily_price_sync`` 抽出（《架构治理规范》§4：存量超限文件禁止继续增长），
只依赖 settings 单行表与自身常量，不感知回补业务细节。

三件事：

- **执行租约**（``price_backfill_running``）：单条条件 UPDATE 原子抢占，保证同一时刻
  只有一个在途回补 run。为什么需要：单轮回补可跑数小时（``pending`` 上限 = 当日剩余
  额度，10 只/批 + 60~120s 批间冷却），而入口那把 settings 行锁在**第一次 commit 就
  已释放**，拦不住「管理员手动首批尚未跑完、15:05 每日收盘价抓取又并发起一个 run」。
- **世代标记**（``price_backfill_run_token``）：区分「已被取消（NULL）」与「被新一次
  触发取代（另一个 UUID）」。只看「标记是否为 NULL」不够：取消后用户可立刻重新触发，
  标记随即又变非 NULL，老批次无法区分「这是我自己的」还是「新批次的」。
- **协作式中止**：中止是**正常路径**——优雅 return :class:`AbortSummary`（``str`` 子类，
  供调用方判定「中止 vs 完成」）摘要字符串，不抛异常、不写 ``price_backfill_last_error``
  （取消不该被记成失败）。

本表恒单行，故所有 UPDATE **故意不带主键 WHERE**（契约同 ``_bump_used_today``）。
"""
from __future__ import annotations

import asyncio
import time
from typing import Optional

from sqlalchemy import select, text

from app.models import DividendYieldSettings

# 「批间冷却」的分片长度（秒）：冷却整段 sleep 会让「取消在途回补」最长等 120s 才被察觉，
# 改为每 _BACKFILL_COOLDOWN_SLICE 秒醒一次复查世代标记（见 _sleep_with_cancel_check）。
# 成本只是冷却期内每片一次单行 SELECT（单行配置表，可忽略）。
_BACKFILL_COOLDOWN_SLICE = 5.0
# 手动首批抢不到执行租约时的**有界等待**上界（秒）与轮询间隔。
# 场景：管理员「取消 → 立刻用新起点重新触发」。此时老任务要跑到下一个取消检查点才中止并
# 释放租约（典型 ≤ 单只耗时，最坏 ≈ 抓取超时 60s + 一次退避 60s），而新首批几乎立刻启动 →
# 若不等待就会命中「租约占用」直接跳过，结果是**当天什么都不跑、要等次日 15:05 续跑**。
# 上界取 180s 覆盖最坏中止延迟；超期仍拿不到则按原语义跳过（绝不放行并发）。
_BACKFILL_LEASE_WAIT_SECONDS = 180.0
_LEASE_RETRY_INTERVAL = 1.0


class AbortSummary(str):
    """协作式中止的摘要字符串（``str`` 子类），让调用方**区分「中止」与「完成」**。

    为什么是 ``str`` 子类，而不是新的返回类型（tuple / dataclass / 结果对象）：
    ``backfill_historical`` 的返回值会被**直接拼进任务结果串**
    （``MarketDailyPriceSyncService.daily_close_fetch`` 的 ``backfill_note``、
    ``run_pending_price_backfill`` 的返回），并被既有测试按**子串**断言。换一种返回类型
    会波及全部调用方与既有用例；``str`` 子类完整保留「可直接当字符串用」的行为，
    只额外提供一个廉价判定：``isinstance(x, AbortSummary)``。

    用途：``run_pending_price_backfill`` 的 rebuild 游标**只在本批真正完成时**推进；
    中止（被取消 / 被新一次触发取代）是优雅 return，不推进——否则会覆盖 DELETE 端点
    清 ``price_backfill_rebuild_cursor`` 的意图，或在「取消 → 立刻重新触发」时让新 run
    从旧批尾部续跑、跳过池首一段（该段保留旧复权口径）。
    """


def _abort_summary(done: int, written: int, skipped: int) -> AbortSummary:
    """协作式取消的中止摘要（**不抛异常**：取消是正常路径，不该被记成失败）。

    返回 :class:`AbortSummary`（``str`` 子类），供调用方据 ``isinstance`` 识别「本批被中止」。
    """
    return AbortSummary(
        "回补已中止（世代标记失效：已被取消，或被新一次触发取代）："
        f"已处理 {done} 只，写入行 {written}，跳过 {skipped} 只；"
        "已写入的日线行一律保留，剩余证券未抓取"
    )


async def _acquire_backfill_lease(session, *, timeout: float = 0.0) -> bool:
    """抢占回补执行租约（``price_backfill_running``）；抢到返回 True。

    用一条条件 UPDATE 原子抢占：``WHERE running = false`` → rowcount 1 即抢到；
    rowcount 0 表示已有 run 在执行（或上次异常退出的残留，由应用启动流程复位）。
    本表恒单行，故**不带主键 WHERE**（契约同 ``_bump_used_today``）。

    ``timeout > 0`` 时按 ``_LEASE_RETRY_INTERVAL`` 轮询重试到上界：仅**手动首批**
    需要（见 ``_BACKFILL_LEASE_WAIT_SECONDS``），每日续跑等不及也没必要等，用默认 0。
    """
    deadline = time.monotonic() + max(float(timeout), 0.0)
    while True:
        res = await session.execute(
            text(
                "UPDATE dividend_yield_settings SET price_backfill_running = true "
                "WHERE price_backfill_running = false"
            )
        )
        await session.commit()
        if max(int(res.rowcount or 0), 0) == 1:
            return True
        if time.monotonic() >= deadline:
            return False
        await asyncio.sleep(_LEASE_RETRY_INTERVAL)


async def _release_backfill_lease(session) -> None:
    """释放回补执行租约（正常 / 熔断 / 取消都在 ``finally`` 调用，防止卡死）。"""
    await session.execute(
        text("UPDATE dividend_yield_settings SET price_backfill_running = false")
    )
    await session.commit()


async def _backfill_run_still_valid(session, run_token: Optional[str]) -> bool:
    """本次在途回补的**世代标记**是否仍然有效（未被取消、也未被新一次触发取代）。

    - ``run_token`` 为 ``None``：非在途链路（如定时任务带 ``backfill_start`` 参数直接
      调 ``backfill_historical``），永不做取消判定，保持既有行为；
    - 当前库值 == 快照值 → 有效；
    - 当前库值为 ``NULL`` → 已被取消；为另一个 UUID → 已被新一次触发取代。
    """
    if run_token is None:
        return True
    current = await session.scalar(
        select(DividendYieldSettings.price_backfill_run_token).limit(1)
    )
    return current == run_token


async def _sleep_with_cancel_check(
    session, run_token: Optional[str], seconds: float
) -> bool:
    """分片 sleep 并在片间复查世代标记；**应中止**返回 True。

    整段 ``asyncio.sleep`` 会让取消最长等到冷却结束（≤120s）；分片后最迟
    ``_BACKFILL_COOLDOWN_SLICE`` 秒即可响应。``run_token`` 为 None 时退化为普通 sleep。
    """
    if run_token is None:
        await asyncio.sleep(seconds)
        return False
    waited = 0.0
    while waited < seconds:
        step = min(_BACKFILL_COOLDOWN_SLICE, seconds - waited)
        await asyncio.sleep(step)
        waited += step
        if not await _backfill_run_still_valid(session, run_token):
            return True
    return False
