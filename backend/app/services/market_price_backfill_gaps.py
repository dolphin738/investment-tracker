"""严格补洞（gap）模式的「洞」状态落库 / 清理（迁移 0021 的 ``market_price_backfill_gaps``）。

自 ``market_daily_price_sync`` 抽出（《架构治理规范》§4：存量超限文件禁止继续增长）。
职责边界：**只**负责「洞」这一状态表的读写——

- ``sync_price_backfill_gaps``：按交易日历重算洞并幂等落库（护栏一~三）；
- ``_bump_gap_attempts``：本批洞 ``attempts`` +1，达阈值置 exhausted（护栏二）；
- ``reconcile_price_backfill_gaps``：补上即删（洞即数据本身，不留终态）；
- ``clear_price_backfill_gaps``：起点/判定基准变更时整表清空（仅 POST/DELETE 两处调用）。

**选批**（``_select_gap_backfill_masters``，须与 legacy / rebuild 两条选批腿同口径）留在
``market_daily_price_sync``；本模块不反向依赖它，避免循环导入。
"""
from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Optional

from sqlalchemy import exists, func, select, text
from sqlalchemy import update as sa_update

from app.core.date_utils import today_app_tz
from app.models import (
    GAP_STATUS_EXHAUSTED,
    GAP_STATUS_PENDING,
    MarketPriceBackfillGap,
    MarketTradeCalendar,
)

# 严格补洞（gap）模式：单个洞被纳入批次的次数上限。达到该次数仍未被填上 → status 置
# exhausted 并不再入批（护栏二）。取 2 是「容忍一次偶发数据源抖动」与「不无限重试」的折中：
# 首次入批可能因当日额度/网络抖动没跑成，第二次仍填不上基本可判定该日数据确实取不到
# （停牌、退市后无行情等），继续重试只会每天重复消耗额度。
_GAP_MAX_ATTEMPTS = 2

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# 严格补洞（gap）模式：按交易日历逐日比对，回填「日历有、日线表无」的缺失交易日
# --------------------------------------------------------------------------- #
async def _calendar_covers_window_bounds(
    session, lower: date, upper: date
) -> tuple[bool, bool]:
    """日历是否覆盖回补窗口的**下界**与**上界**，返回 ``(lo_covered, hi_covered)``。

    用两条 ``EXISTS`` 判定，避免把窗口内全部交易日读进内存（窗口可到 1400+ 天）：
    - ``lo_covered``：存在 ``trade_date <= lower`` → 窗口起始已在日历范围内；
    - ``hi_covered``：存在 ``trade_date >= upper`` → 日历延伸到了窗口结束。
    """
    lo_stmt = select(
        exists(
            select(MarketTradeCalendar.trade_date).where(
                MarketTradeCalendar.trade_date <= lower
            )
        )
    )
    hi_stmt = select(
        exists(
            select(MarketTradeCalendar.trade_date).where(
                MarketTradeCalendar.trade_date >= upper
            )
        )
    )
    lo_covered = bool(await session.scalar(lo_stmt))
    hi_covered = bool(await session.scalar(hi_stmt))
    return lo_covered, hi_covered


async def sync_price_backfill_gaps(
    session,
    start_date: date,
    today: Optional[date] = None,
    *,
    skip_exchange: Optional[str] = None,
) -> Optional[int]:
    """按交易日历重算「洞」并落 ``market_price_backfill_gaps``（幂等，只 INSERT 缺失行）。

    洞 = 窗口内的已记录交易日中，该证券 ``market_security_daily_prices`` 没有对应行的日子。

    三条护栏：
    1. **上界 = 昨天**（``upper = today - 1 天``）：今天的日线可能尚未抓取（日线任务 15:05
       才跑），把今天当洞会让每只证券每天必然多出一个「永远填不满」的洞 → 任务永不结束；
    2. **只对「起点已覆盖」的证券记洞**：完全未覆盖的证券由 legacy 分支兜住
       （``_select_gap_backfill_masters`` 取并集），否则「N 只 × 窗口交易日」会瞬间撑爆
       状态表。单只证券的洞行数上界 = 窗口交易日数；
       另：``skip_exchange``（如腾讯源无京A → ``'BJ'``）在**建洞时**也排除该交易所，与
       ``_select_pending_backfill_masters`` / ``_select_gap_backfill_masters`` 两条选批腿
       同口径——否则这些洞会被永久创建又永远不入批（不 exhausted、也不影响补完判定），
       只是白占状态表；并顺带清理修复前遗留的该类洞（自愈）；
    3. **日历不覆盖窗口两端 → 返回 None**（不是 0）：判据是窗口**两端**是否都有日历记录
       （``trade_date <= start_date`` 且 ``trade_date >= upper``）。仅判「窗口内任意一天
       在日历里」是不充分的——日历若在窗口尾部断层（例如只到 03-01，而窗口上界在 03-07），
       尾部整段「日历有、日线无」的交易日会被静默漏判、永不回补，任务还会被误判成
       「补完」。任一端不覆盖即**无从判定**哪些日子该有数据，返回 0 会被误读成
       「没有洞 → 补完」并错误清空在途标记，故用 None 明确表达「无法判定」，
       由调用方回落 legacy（legacy 至少按前边界处理，不会漏补后误报「完成」）。

    返回新增洞行数；``None`` = 日历未覆盖窗口两端、无法判定。
    """
    today = today or today_app_tz()
    upper = today - timedelta(days=1)  # 护栏一：上界 = 昨天
    if upper < start_date:
        return 0
    lo_covered, hi_covered = await _calendar_covers_window_bounds(
        session, start_date, upper
    )
    if not (lo_covered and hi_covered):
        logger.warning(
            "交易日历未覆盖回补窗口 %s..%s 两端（下界覆盖=%s，上界覆盖=%s），"
            "gap 模式无法判定洞，本轮应回落 legacy 口径",
            start_date.isoformat(),
            upper.isoformat(),
            lo_covered,
            hi_covered,
        )
        return None  # 护栏三：无从判定，交由调用方回落 legacy

    # 池 = 有分红记录且「起点已覆盖」的证券（护栏二：排除完全未覆盖的，避免行爆炸），
    # 与窗口内的「已记录交易日」做差集，落 pending 洞行。
    #
    # 用**库内一条 SQL** 完成：规模上界 = 池规模 × 窗口交易日数（起始日期可配到很早，
    # 如 2020 起则窗口内 1400+ 个交易日 → 4609 × 1400 ≈ 645 万对），且本函数每轮回补
    # （含每日收盘价抓取后的续跑）都会执行——若把已覆盖日线行与已知洞行全量读进内存再
    # 逐对判断，会显著拖慢每日任务。ON CONFLICT DO NOTHING 天然幂等，重复调用不产生重复洞。
    # 窗口外的存量洞行（起始日期收紧 / 日期推移后）不再有效，先清掉：
    # 否则「只剩陈旧洞」的证券会被反复判待补（白烧额度），并在 attempts 达阈值后
    # 被无谓置 exhausted，真实洞反而再也补不上。
    await session.execute(
        text(
            "DELETE FROM market_price_backfill_gaps "
            "WHERE gap_date < :lo OR gap_date > :hi"
        ),
        {"lo": start_date, "hi": upper},
    )
    if skip_exchange is not None:
        # 自愈：清掉修复前遗留的「被该源跳过交易所」的洞（此前建洞未按源过滤 → 永久堆积）。
        await session.execute(
            text(
                "DELETE FROM market_price_backfill_gaps g "
                "USING securities s "
                "WHERE s.id = g.master_id "
                "AND s.exchange = CAST(:skip_exchange AS varchar)"
            ),
            {"skip_exchange": skip_exchange},
        )

    res = await session.execute(
        text(
            """
            INSERT INTO market_price_backfill_gaps
                (id, master_id, gap_date, status, attempts, created_at, updated_at)
            SELECT gen_random_uuid(), m.master_id, c.trade_date,
                   CAST(:pending AS varchar), 0, now(), now()
            FROM (
                SELECT DISTINCT sd.master_id
                FROM security_dividends sd
                JOIN securities s ON s.id = sd.master_id
                WHERE (
                    CAST(:skip_exchange AS varchar) IS NULL
                    OR s.exchange IS NULL
                    OR s.exchange <> CAST(:skip_exchange AS varchar)
                )
                  AND EXISTS (
                    SELECT 1 FROM market_security_daily_prices p
                    WHERE p.master_id = sd.master_id AND p.trade_date <= :lo
                )
            ) m
            CROSS JOIN market_trade_calendar c
            WHERE c.trade_date BETWEEN :lo AND :hi
              AND NOT EXISTS (
                  SELECT 1 FROM market_security_daily_prices p2
                  WHERE p2.master_id = m.master_id AND p2.trade_date = c.trade_date
              )
              AND NOT EXISTS (
                  SELECT 1 FROM market_price_backfill_gaps g
                  WHERE g.master_id = m.master_id AND g.gap_date = c.trade_date
              )
            ON CONFLICT (master_id, gap_date) DO NOTHING
            """
        ),
        {
            "lo": start_date,
            "hi": upper,
            "pending": GAP_STATUS_PENDING,
            "skip_exchange": skip_exchange,
        },
    )
    # rowcount 防御：-1 是 truthy，`or 0` 兜不住（部分驱动对 INSERT...ON CONFLICT 可能回 -1），
    # 故统一 max(..., 0) 归一到非负计数。
    added = max(int(res.rowcount or 0), 0)
    return added


async def _bump_gap_attempts(session, master_ids: list[str]) -> int:
    """本批证券的 pending 洞 ``attempts`` +1；达阈值（≥2）的置 ``exhausted``（护栏二）。

    返回被置 exhausted 的洞行数。用 Core UPDATE 而非逐行 ORM：洞行数可能成百上千，
    且调用方会话可能刚经历过 rollback（无需依赖对象新鲜度）。
    """
    if not master_ids:
        return 0
    # Core UPDATE 不触发 ORM 的 Python 端 onupdate（TimestampMixin），故显式刷 updated_at，
    # 保证洞行的审计时间戳与状态变更同步。
    await session.execute(
        sa_update(MarketPriceBackfillGap)
        .where(
            MarketPriceBackfillGap.master_id.in_(master_ids),
            MarketPriceBackfillGap.status == GAP_STATUS_PENDING,
        )
        .values(
            attempts=MarketPriceBackfillGap.attempts + 1,
            updated_at=func.now(),
        )
    )
    res = await session.execute(
        sa_update(MarketPriceBackfillGap)
        .where(
            MarketPriceBackfillGap.master_id.in_(master_ids),
            MarketPriceBackfillGap.status == GAP_STATUS_PENDING,
            MarketPriceBackfillGap.attempts >= _GAP_MAX_ATTEMPTS,
        )
        .values(status=GAP_STATUS_EXHAUSTED, updated_at=func.now())
    )
    # rowcount 防御：-1 是 truthy，`or 0` 兜不住，统一 max(..., 0) 归一。
    return max(int(res.rowcount or 0), 0)


async def reconcile_price_backfill_gaps(session) -> int:
    """删掉已被填上的洞（``(master_id, gap_date)`` 已有日线行）；返回删除行数。

    洞即数据本身：补上即删，不留终态。用 ``DELETE ... USING`` 一条 SQL 完成关联删除，
    避免把（可能成百上千行）洞读进内存再逐行 delete。
    """
    res = await session.execute(
        text(
            "DELETE FROM market_price_backfill_gaps g "
            "USING market_security_daily_prices p "
            "WHERE p.master_id = g.master_id AND p.trade_date = g.gap_date"
        )
    )
    # rowcount 防御：-1 是 truthy，`or 0` 兜不住，统一 max(..., 0) 归一。
    return max(int(res.rowcount or 0), 0)


async def clear_price_backfill_gaps(session) -> int:
    """清空 ``market_price_backfill_gaps``（严格补洞状态），返回删除行数。

    调用时机**严格限定两处**（均在路由层、与在途标记同事务提交）：
    - ``POST /backfill-prices`` 写入 ``price_backfill_start_date`` 时；
    - ``DELETE /backfill-prices`` 取消、清 ``price_backfill_start_date`` 时。

    为什么清空：起点 / 判定基准变了 → 旧洞（含已 exhausted 的）全部失效、须重建；
    同时给「数据源长期给不到的日期」一条显式重试路径——gap 模式下洞的 ``attempts``
    达阈值会被置 exhausted 且不再入批，清空即重置该状态、可重新尝试。

    ⚠️ **绝对禁止**在 ``run_pending_price_backfill`` / 每日续跑链路里调用本函数：
    那会把 attempts 每天归零 → 停牌洞永远循环（活锁），正是护栏二要防的。
    """
    res = await session.execute(text("DELETE FROM market_price_backfill_gaps"))
    # rowcount 防御：-1 是 truthy，`or 0` 兜不住，统一 max(..., 0) 归一。
    return max(int(res.rowcount or 0), 0)
