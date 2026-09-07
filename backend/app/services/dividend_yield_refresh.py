"""股息率派生快照刷新 / stale 治理 / 交易日历（自 dividend_sync.py 拆出，P2-6）。

- ``refresh_yields_for_masters``：变更集重算派生快照（§2.5/§7），批量预取、不碰 stale；
- ``update_stale_flags``：§7 stale 唯一定责处（任务末按交易日历统一扫描）；
- ``refresh_trade_calendar`` / ``is_trade_day``：交易日历刷新与校验（§5.5 防线一）。

被 market_daily_price_sync（日线任务）与 dividend_notice_scan（公告扫描）复用，
故独立于 ``DividendSyncService``——后者负责采集，派生刷新职责不归属采集服务。
"""
from __future__ import annotations

import asyncio
import logging
from datetime import date, datetime, timezone

from sqlalchemy import case, func, select, tuple_, update as sa_update

from app.core.date_utils import today_app_tz
from app.models import (
    MarketSecurityDailyPrice,
    MarketTradeCalendar,
    SecurityDividend,
    SecurityDividendYield,
)
from app.models.enums import DividendYieldMode
from app.services.dividend_period import parse_date
from app.services.dividend_yield import (
    compute_yield,
    consecutive_years,
    is_suspicious,
    last_dividend_year,
    to_cell,
)

logger = logging.getLogger(__name__)


async def refresh_yields_for_masters(session, master_ids: list[str]) -> None:
    """对指定 master 集合重派生 ``security_dividend_yields`` 快照（§2.5/§7 变更集重算）。

    - 分母 = 该证券最新不复权收盘价（``market_security_daily_prices`` 最大 trade_date）；
    - 复用纯函数 ``compute_yield``/``consecutive_years``，保证末端曲线点 == 快照（§9 一致性）；
    - 无分红记录或价格缺失 → ``dividend_yield=None``（缺失而非 0）；
    - **stale 不由本函数管辖**（§7 / P2-4）：stale 是「收盘价新鲜度」标记，唯一定责于
      ``update_stale_flags``（日线任务末按交易日历统一扫描）。此前本函数无条件
      ``stale=False`` 会抹掉刚算出的 stale——日线流程里 ``update_stale_flags`` 先于本函数
      执行（market_daily_price_sync.daily_close_fetch），06:00 公告扫描路径更是从不调用
      ``update_stale_flags``，stale 一旦被抹须等次日 15:05 才恢复；故此处保持不动；
    - 批量预取（P2-4）：分红 / 最新收盘价 / 既有快照各一次批量查询，取代逐证券 3 查的 N+1；
    - 干净执行（任一 master 失败不中断其余），调用方捕获提交。
    """
    if not master_ids:
        return
    mids = list(dict.fromkeys(master_ids))  # 去重保留顺序
    cur_year = today_app_tz().year

    # ① 批量取全部相关分红记录
    div_rows_all = (
        await session.execute(
            select(SecurityDividend)
            .where(SecurityDividend.master_id.in_(mids))
            .order_by(
                SecurityDividend.report_year.desc(),
                SecurityDividend.report_quarter.desc(),
            )
        )
    ).scalars().all()
    divs_by_master: dict[str, list[SecurityDividend]] = {}
    for r in div_rows_all:
        divs_by_master.setdefault(r.master_id, []).append(r)

    # ② 批量取每证券最新收盘价：先按 master 聚合最大 trade_date，再按 (master, date) 取行
    max_date_pairs = (
        await session.execute(
            select(
                MarketSecurityDailyPrice.master_id,
                func.max(MarketSecurityDailyPrice.trade_date),
            )
            .where(MarketSecurityDailyPrice.master_id.in_(mids))
            .group_by(MarketSecurityDailyPrice.master_id)
        )
    ).all()
    price_by_master: dict[str, MarketSecurityDailyPrice] = {}
    if max_date_pairs:
        price_rows = (
            await session.execute(
                select(MarketSecurityDailyPrice).where(
                    tuple_(
                        MarketSecurityDailyPrice.master_id,
                        MarketSecurityDailyPrice.trade_date,
                    ).in_([(m, d) for m, d in max_date_pairs])
                )
            )
        ).scalars().all()
        price_by_master = {p.master_id: p for p in price_rows}

    # ③ 批量取既有快照
    snap_by_master = {
        s.master_id: s
        for s in (
            await session.execute(
                select(SecurityDividendYield).where(
                    SecurityDividendYield.master_id.in_(mids)
                )
            )
        ).scalars().all()
    }

    for mid in mids:
        try:
            cells = [to_cell(r) for r in divs_by_master.get(mid, [])]
            price_row = price_by_master.get(mid)
            price = price_row.close if price_row is not None else None
            latest_trade_date = price_row.trade_date if price_row is not None else None

            result = compute_yield(cells, price, cur_year)
            mode = result.mode if result.ref_div_ids else DividendYieldMode.LFY
            snapshot = snap_by_master.get(mid)
            if snapshot is None:
                snapshot = SecurityDividendYield(master_id=mid, mode=mode)
                session.add(snapshot)
                snap_by_master[mid] = snapshot
            snapshot.mode = mode
            snapshot.numerator_per_share = result.numerator_per_share
            snapshot.dividend_yield = result.dividend_yield
            snapshot.latest_price = price
            snapshot.latest_trade_date = latest_trade_date
            snapshot.consecutive_years = consecutive_years(cells, cur_year)
            snapshot.last_dividend_year = last_dividend_year(cells)
            snapshot.ref_div_ids = list(result.ref_div_ids) if result.ref_div_ids else None
            snapshot.suspicious = is_suspicious(result.dividend_yield)
            # stale 保持不动：唯一定责于 update_stale_flags（§7 / P2-4），本函数不重置
            snapshot.computed_at = datetime.now(timezone.utc)
        except Exception:  # 单个证券失败不中断其余（任务级异常由 handler 汇总）
            logger.warning("股息率快照重算失败 master_id=%s，保留旧快照", mid, exc_info=True)
            continue


async def refresh_trade_calendar(session) -> None:
    """刷新交易日历（§5.5/决策 A9）：akshare ``tool_trade_date_hist_sina`` 拉取未来 2 年 + 当年。

    失败仅记告警、不抛出——日线任务可降级依赖「返回日期比对」防线。
    """
    try:
        import akshare  # noqa: PLC0415 懒导入（非 SDK 环境不阻塞）

        df = await asyncio.wait_for(
            asyncio.to_thread(akshare.tool_trade_date_hist_sina), timeout=30
        )
        if df is None or getattr(df, "empty", False):
            return
        col = "trade_date" if "trade_date" in df.columns else df.columns[0]
        t = today_app_tz()
        horizon = date(t.year + 2, 12, 31)
        for raw in df[col].tolist():
            d = parse_date(raw)
            if d is None or d > horizon or d.year < t.year - 1:
                continue
            await session.merge(MarketTradeCalendar(trade_date=d))
    except Exception:  # 刷新失败不阻断清理（§6.3 语义）
        logger.warning("交易日历刷新失败，日线任务降级依赖「返回日期比对」防线", exc_info=True)
        return


async def update_stale_flags(session) -> int:
    """§7 stale 治理：收盘价落后全市场最新交易日 ≥3 个已记录交易日 → ``stale=True``。

    - 基准 = ``market_trade_calendar`` 最新交易日；日历为空时降级为快照表
      ``max(trade_date)`` 基准并记告警（§7 降级语义）；
    - 「落后 ≥3 个已记录交易日」＝ 证券 ``latest_trade_date`` 早于基准日往前数第 3 个
      交易日（含基准日）；基准不足 3 个交易日时无从判定，不动任何行；
    - 由 §6.2 任务末统一调用（非查询时现算）。

    返回被置为 ``stale=True`` 的行数。
    """
    base = (
        await session.execute(select(func.max(MarketTradeCalendar.trade_date)))
    ).scalar_one_or_none()
    if base is not None:
        recent = (
            await session.execute(
                select(MarketTradeCalendar.trade_date)
                .where(MarketTradeCalendar.trade_date <= base)
                .order_by(MarketTradeCalendar.trade_date.desc())
                .limit(3)
            )
        ).scalars().all()
    else:
        logger.warning("交易日历为空，stale 判定降级为快照表已记录交易日（§7）")
        recent = (
            await session.execute(
                select(MarketSecurityDailyPrice.trade_date)
                .distinct()
                .order_by(MarketSecurityDailyPrice.trade_date.desc())
                .limit(3)
            )
        ).scalars().all()
    if len(recent) < 3:
        return 0  # 基准不足 3 个交易日，无从判定落后
    threshold = recent[-1]
    res = await session.execute(
        sa_update(SecurityDividendYield)
        .where(
            SecurityDividendYield.latest_trade_date.is_not(None),
            SecurityDividendYield.stale != (
                SecurityDividendYield.latest_trade_date < threshold
            ),
        )
        .values(
            stale=case(
                (SecurityDividendYield.latest_trade_date < threshold, True),
                else_=False,
            )
        )
    )
    return int(res.rowcount or 0)


async def is_trade_day(session, d: date) -> bool:
    """交易日历校验（§5.5 防线一）。日历表为空时 FAIL-OPEN（交给防线二）并返回 True。"""
    if (
        await session.execute(select(func.count(MarketTradeCalendar.trade_date)).select_from(MarketTradeCalendar))
    ).scalar_one() == 0:
        return True  # 日历空 → 降级交给防线二（返回日期比对，决策 A9）
    return (
        await session.execute(
            select(MarketTradeCalendar.trade_date).where(MarketTradeCalendar.trade_date == d)
        )
    ).scalar_one_or_none() is not None
