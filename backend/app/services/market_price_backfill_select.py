"""回补**选批**（纯查询构造，零 monkeypatch 靶点）。

自 ``market_daily_price_sync`` 抽出（《架构治理规范》§4）。把三条选批腿与在途回补编排解耦，
本模块只按会话构造/执行 SELECT，不写库、不发网络请求：

- ``_select_pending_backfill_masters``：legacy（起点未覆盖）选批；
- ``_select_rebuild_backfill_masters``：rebuild（全量重抓，按 master_id 游标推进）选批；
- ``_select_gap_backfill_masters``：gap（严格补洞）选批（起点未覆盖 ∪ 有未耗尽洞）。

「洞」状态表的落库/清理仍在 ``market_price_backfill_gaps``（本模块只调用其幂等 sync），
边界约定同该模块：拆出模块不回指主文件。
"""
from __future__ import annotations

from datetime import date
from typing import Optional

from sqlalchemy import exists, select

from app.models import (
    GAP_STATUS_PENDING,
    MarketPriceBackfillGap,
    MarketSecurityDailyPrice,
    Security,
    SecurityDividend,
)
from app.services.market_price_backfill_gaps import (
    _GAP_MAX_ATTEMPTS,
    sync_price_backfill_gaps,
)


async def _select_pending_backfill_masters(
    session, start_date: date, quota: int, skip_exchange: Optional[str] = None
) -> list[str]:
    """精确选出未覆盖证券的 master_id 列表（限 quota 只，按 master_id 稳定排序）。

    未覆盖 = 该证券在 ``market_security_daily_prices`` 不存在
    ``trade_date <= start_date`` 的日线行（断点即数据本身，语义同 backfill_historical
    的跳过判定）。用一条 SQL 的 NOT EXISTS 子查询精确定位，而非逐只判定：
      ① 每日批次可精确知道「还有没有剩余」，据此决定是否清空在途状态（终态），避免 §6.3
         留存清理删早期数据后各证券 earliest 变晚、被判定未覆盖 → 每天重复请求全池、
         次年再被删的无限循环白烧配额；
      ② 避免每天扫全池 4609 次查询/请求，只按需取本批（≤ quota）。
    """
    subq = select(MarketSecurityDailyPrice.master_id).where(
        MarketSecurityDailyPrice.master_id == SecurityDividend.master_id,
        MarketSecurityDailyPrice.trade_date <= start_date,
    )
    stmt = (
        select(SecurityDividend.master_id)
        .distinct()
        .where(~exists(subq))
        .order_by(SecurityDividend.master_id)
        .limit(quota)
    )
    if skip_exchange is not None:
        # 方案 D：跳过指定交易所（如腾讯历史行情不含京A → 排除 BJ）。
        # 交易所未知（NULL）的证券保留，避免误伤无法判定者。
        stmt = stmt.join(Security, Security.id == SecurityDividend.master_id).where(
            Security.exchange.is_(None) | (Security.exchange != skip_exchange)
        )
    return list((await session.execute(stmt)).scalars().all())


async def _select_rebuild_backfill_masters(
    session,
    cursor: Optional[str],
    quota: int,
    skip_exchange: Optional[str] = None,
) -> list[str]:
    """**全量重抓（rebuild）**模式的待办名单：按 ``master_id`` **游标**升序推进（限 quota 只）。

    池 = 有分红记录的证券（与 ``_select_pending_backfill_masters`` 同全集），但**不做任何
    覆盖度筛选** —— 本模式的目的就是重抓全部、抹平复权口径差异（如 adjust 从 '' 切到 qfq）。

    为什么必须用游标：legacy / gap 的选批判据本身会收敛（「起点未覆盖」/「有未耗尽洞」），
    抓完自然选不出人；而「全部有分红证券」是**恒定集合**，没有游标就会每轮重新选中全池 →
    任务永不结束、每日额度天天烧满。游标 = 上一批的最后一个 ``master_id``，取不出下一批
    即到池尾，由调用方判终态（清游标 + 清在途标记）。
    """
    stmt = (
        select(SecurityDividend.master_id)
        .distinct()
        .order_by(SecurityDividend.master_id)
        .limit(quota)
    )
    if cursor is not None:
        stmt = stmt.where(SecurityDividend.master_id > cursor)
    if skip_exchange is not None:
        # 与另两条选批腿同口径：跳过该源拿不到的交易所（交易所未知的保留，避免误伤）
        stmt = stmt.join(Security, Security.id == SecurityDividend.master_id).where(
            Security.exchange.is_(None) | (Security.exchange != skip_exchange)
        )
    return list((await session.execute(stmt)).scalars().all())


async def _select_gap_backfill_masters(
    session, start_date: date, quota: int, skip_exchange: Optional[str] = None
) -> tuple[list[str], bool]:
    """gap 模式待补名单：``起点未覆盖`` ∪ ``有未耗尽洞``（限 quota 只，按 master_id 排序）。

    返回 ``(master_ids, calendar_ok)``；``calendar_ok=False`` 表示交易日历不覆盖回补窗口、
    无法按洞判定，调用方须回落 legacy（护栏三）。
    """
    synced = await sync_price_backfill_gaps(
        session, start_date, skip_exchange=skip_exchange
    )
    if synced is None:
        return [], False
    # 起点未覆盖（legacy 口径）：兜住完全无数据 / 起点之前无数据的证券
    uncovered = await _select_pending_backfill_masters(
        session, start_date, quota, skip_exchange
    )
    # 有洞且未耗尽：attempts 达阈值的已置 exhausted，不在此列（护栏二）
    gapped_stmt = (
        select(MarketPriceBackfillGap.master_id)
        .where(
            MarketPriceBackfillGap.status == GAP_STATUS_PENDING,
            MarketPriceBackfillGap.attempts < _GAP_MAX_ATTEMPTS,
        )
        .distinct()
        .order_by(MarketPriceBackfillGap.master_id)
        .limit(quota)
    )
    if skip_exchange is not None:
        # 方案 D：gapped 腿同样跳过腾讯源无数据的交易所（如 BJ），
        # 直接 JOIN securities 在 SQL 端排除，避免把已跳过洞计入配额。
        gapped_stmt = gapped_stmt.join(
            Security, Security.id == MarketPriceBackfillGap.master_id
        ).where(
            Security.exchange.is_(None) | (Security.exchange != skip_exchange)
        )
    gapped = list((await session.execute(gapped_stmt)).scalars().all())
    return sorted(set(uncovered) | set(gapped))[:quota], True
