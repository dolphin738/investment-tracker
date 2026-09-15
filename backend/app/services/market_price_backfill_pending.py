"""在途回补**编排**：每日额度 + 游标推进 + gap 收敛（形态 A，§6.2 在途任务）。

自 ``market_daily_price_sync`` 抽出（《架构治理规范》§4）。

- ``run_pending_price_backfill``：按每日额度跑一批待补证券的历史日线；补完即清空在途状态；
- ``_TX_HIST_ENDPOINT`` / ``_skip_exchange_for_source``：腾讯历史行情接口
  （``stock_zh_a_hist_tx``）不含京A（BJ）数据时的**接口级**跳过（方案 D）。

⚠️ 跨模块调用引擎 ``backfill_historical`` 一律走**属性访问**（``engine.backfill_historical``）：
``backfill_historical`` 是 monkeypatch 靶点，只有「调用点运行时按属性查引擎模块」才能让
``monkeypatch.setattr("app.services.market_price_backfill_engine.backfill_historical", ...)``
命中本模块的调用点；若改用 ``from ... import backfill_historical`` 会打空、**静默失效**。
"""
from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import func, select

from app.core.date_utils import today_app_tz
from app.models import (
    GAP_STATUS_EXHAUSTED,
    PRICE_BACKFILL_MODE_GAP,
    PRICE_BACKFILL_MODE_LEGACY,
    PRICE_BACKFILL_MODE_REBUILD,
    DividendYieldSettings,
    MarketPriceBackfillGap,
    QuoteInterface,
    SecuritiesDataProvider,
)
from app.models.enums import QuoteProviderAccessMethod
from app.services import market_price_backfill_engine as engine
from app.services.market_data_sync import QUOTE_CAT_ID
from app.services.market_price_backfill_engine import _set_last_error
from app.services.market_price_backfill_gaps import (
    _bump_gap_attempts,
    reconcile_price_backfill_gaps,
)
from app.services.market_price_backfill_lease import (
    AbortSummary,
    _acquire_backfill_lease,
    _backfill_run_still_valid,
    _release_backfill_lease,
)
from app.services.market_price_backfill_select import (
    _select_gap_backfill_masters,
    _select_pending_backfill_masters,
    _select_rebuild_backfill_masters,
)

logger = logging.getLogger(__name__)

# 腾讯历史行情接口（akshare stock_zh_a_hist_tx）不含京A（北交所 BJ）数据；
# 该接口回补时须自动跳过京A证券，否则空耗额度/报错。以接口的 endpoint 标识该源，
# 属「接口级」跳过（方案 D）——切回含 BJ 数据的接口（如东财 stock_zh_a_hist）即自动
# 恢复，无需人工改配置（区别于全局池级排除方案 C）。
_TX_HIST_ENDPOINT = "stock_zh_a_hist_tx"


def _skip_exchange_for_source(itf: Optional["QuoteInterface"]) -> Optional[str]:
    """回补源为腾讯历史行情接口时返回须跳过的交易所代码（'BJ'），否则 None。"""
    if itf is None:
        return None
    return "BJ" if itf.endpoint == _TX_HIST_ENDPOINT else None


async def run_pending_price_backfill(
    session, *, wait_for_lease: float = 0.0
) -> str:
    """在途回补任务：按每日额度跑一批未覆盖证券的历史日线；补完即清空在途状态。

    供两处复用：路由 ``POST /backfill-prices`` 首批、每日「收盘价抓取」完成后续跑。

    ``wait_for_lease``：抢不到执行租约时的等待上界（秒），**仅手动首批传**
    （``_BACKFILL_LEASE_WAIT_SECONDS``）——「取消后立刻重新触发」时老任务要跑到下一个
    取消检查点才释放租约，等待可避免新首批直接跳过导致当天不跑。每日续跑用默认 0：
    它本来就是「有空位就补、没空位下次再说」，不值得等。

    语义（严格）：
    1. 读 ``dividend_yield_settings``：无行或 ``price_backfill_start_date`` 为空 → 无在途
       任务，直接返回提示、**不发任何请求**（no-op，不破坏每日收盘价抓取）。
    2. 解析回补接口（settings.price_backfill_source_interface_id + 分类 2 + enabled +
       sdk）；接口缺失/停用/非 sdk → 抛 RuntimeError（中文，fail fast）。
    3. 一条 SQL 精确选出本批待补证券（未覆盖的，**限当日剩余额度**；
       quota 为 None 兜底 1000）。额度按**自然日**消耗：任何方式/原因触发的执行都
       记入 ``price_backfill_used_today``（按本批实际处理只数，成败都计），
       跨日（``price_backfill_last_run_date`` ≠ 今天）自动归零；同日再次执行只能在
       ``remaining = quota - used_today`` 范围内取批，余额 ≤ 0 则当日不再发起请求。
    4. 若选出 0 只 → 判定补完：清空 ``price_backfill_start_date`` 并 commit，返回
       「已结束」提示、**不发任何请求**（终态，避免无限循环白烧配额）。
    5. 否则调用 ``backfill_historical`` 跑本批，返回其摘要（加前缀注明本批只数/额度）。
    6. start_date 从 settings.price_backfill_start_date 读（date 类型）。

    为什么用「一条 SQL 精确定位未覆盖」而不是逐只判定——见 ``_select_pending_backfill_masters``
    文档串：① 每日批次可精确知晓「还有无剩余」以决定清状态；② 避免每天扫全池 4609 次。
    """
    # 行锁：当日额度是共享资源，手动触发与每日续跑可能并发，
    # 加锁避免两者同时读到 used_today=0 而各自跑满额度（同日双花）。
    settings = (
        await session.execute(
            select(DividendYieldSettings).limit(1).with_for_update()
        )
    ).scalar_one_or_none()
    if settings is None or settings.price_backfill_start_date is None:
        return "无在途回补任务（price_backfill_start_date 为空），本次不发起请求"

    start_date = settings.price_backfill_start_date
    quota = settings.price_backfill_quota if settings.price_backfill_quota is not None else 1000

    # 当日记账：额度按**自然日**消耗，跨日自动重置；同日只在剩余额度内取批。
    today = today_app_tz()
    if settings.price_backfill_last_run_date != today:
        settings.price_backfill_last_run_date = today
        settings.price_backfill_used_today = 0
    remaining = quota - (settings.price_backfill_used_today or 0)
    if remaining <= 0:
        await session.commit()  # 落「今日已重置」的记账
        return (
            f"今日回补额度已用尽（{quota} 只/天），本次不发起请求；"
            "明日自动续跑（额度按自然日重置）"
        )

    # 解析回补接口：price_backfill_source_interface_id + 分类 2 + enabled + sdk（fail fast）
    interface_id = settings.price_backfill_source_interface_id
    if not interface_id:
        raise RuntimeError(
            "历史行情回补接口未配置（price_backfill_source_interface_id 为空），"
            "无法执行在途回补任务"
        )
    itf = await session.get(QuoteInterface, interface_id)
    if itf is None or itf.category_id != QUOTE_CAT_ID or not itf.enabled:
        raise RuntimeError(
            f"历史行情回补接口不存在/分类不符/未启用（{interface_id}），在途回补任务中止"
        )
    # 方案 D：腾讯历史行情接口（stock_zh_a_hist_tx）不含京A（北交所 BJ）数据，
    # 回补时自动跳过该交易所证券，避免空耗额度/报错；切回含 BJ 数据的接口即自动恢复。
    skip_exchange = _skip_exchange_for_source(itf)
    provider = await session.get(SecuritiesDataProvider, itf.provider_id)
    if provider is None or provider.access_method != QuoteProviderAccessMethod.SDK:
        raise RuntimeError(
            "历史行情回补接口接入方式须为 sdk（akshare stock_zh_a_hist），"
            f"当前接口 {itf.name!r} 的提供方接入方式为 "
            f"{provider.access_method if provider else '未知'}，在途回补任务中止"
        )

    # 按回补模式分派选批：
    # - legacy（存量默认）：原「起点未覆盖」口径——起点一覆盖就整只跳过，中间空洞不补；
    # - gap（严格补洞）：按交易日历逐日比对，把「起点已覆盖但中间缺日」的证券重新纳入；
    #   交易日历不覆盖回补窗口时无从判定洞 → 回落 legacy（护栏三），不静默空转；
    # - rebuild（全量重抓）：不做覆盖度筛选，按 master_id 游标推进全池重抓；**清空后重建**
    #   （replace=True：先删该证券窗口内既有日线再整段写入，不留旧源/旧复权口径的数据），
    #   游标走到池尾即终态。
    mode = settings.price_backfill_mode or PRICE_BACKFILL_MODE_LEGACY
    # gap 只须「不跳过」（force），rebuild 须「清空重写」（replace）：前者洞在「起点已覆盖」
    # 的证券上、未返回的日期要保留；后者目的就是不留任何旧数据。
    force = False
    gap_active = False
    rebuild_active = False
    if mode == PRICE_BACKFILL_MODE_GAP:
        pending, calendar_ok = await _select_gap_backfill_masters(
            session, start_date, remaining, skip_exchange
        )
        if calendar_ok:
            force = True
            gap_active = True
        else:
            logger.warning(
                "回补模式为 gap，但交易日历不覆盖回补窗口（起点 %s），本轮回落 legacy 口径；"
                "请先执行交易日历刷新任务",
                start_date.isoformat(),
            )
            pending = await _select_pending_backfill_masters(
                session, start_date, remaining, skip_exchange
            )
    elif mode == PRICE_BACKFILL_MODE_REBUILD:
        force = True
        rebuild_active = True
        pending = await _select_rebuild_backfill_masters(
            session, settings.price_backfill_rebuild_cursor, remaining, skip_exchange
        )
    else:
        pending = await _select_pending_backfill_masters(
            session, start_date, remaining, skip_exchange
        )

    # 执行占用租约：同一时刻只允许一个回补 run。
    # 单轮可跑数小时（pending 上限 = 当日剩余额度，10 只/批 + 60~120s 批间冷却），
    # 而入口那把 settings 行锁在**第一次 commit 就已释放**，拦不住「管理员手动首批尚未跑完
    # + 15:05 每日收盘价抓取又并发起一个 run」——两者会各选一批、重复抓取同一池子且额度双计。
    if not await _acquire_backfill_lease(session, timeout=wait_for_lease):
        logger.info("回补执行租约已被占用（已有 run 在执行），本次跳过、不发起请求")
        return "已有回补任务正在执行中（同一时刻只允许一个 run），本次跳过"
    try:
        if not pending:
            # 全部已覆盖 → 补完，清空在途状态（终态），此后不再跑。
            # 终态不再静默：gap 模式下把已放弃（exhausted）的洞数一并告知——这些洞是数据源
            # 长期未提供的日期，attempts 达阈值后不再入批；重新触发回补（POST
            # /backfill-prices 会清空洞表）即可重置状态重试。
            exhausted_note = ""
            if mode == PRICE_BACKFILL_MODE_GAP:
                exhausted_count = int(
                    await session.scalar(
                        select(func.count())
                        .select_from(MarketPriceBackfillGap)
                        .where(MarketPriceBackfillGap.status == GAP_STATUS_EXHAUSTED)
                    )
                    or 0
                )
                if exhausted_count > 0:
                    exhausted_note = (
                        f"；另有 {exhausted_count} 个洞因数据源长期未提供已放弃"
                        "（exhausted）；重新触发回补可重置状态重试"
                    )
            settings.price_backfill_start_date = None
            settings.price_backfill_last_error = None
            # rebuild：游标走到池尾即完成 → 一并清游标（下次重新触发从头开始）
            settings.price_backfill_rebuild_cursor = None
            await session.commit()
            if mode == PRICE_BACKFILL_MODE_REBUILD:
                return "全量重抓已完成（已走完证券池），在途回补任务已结束"
            return (
                f"回补已完成（{mode} 模式）：全部证券均已覆盖、无待补洞，"
                f"在途回补任务已结束{exhausted_note}"
            )

        # 新一轮尝试：先清掉上一次遗留的失败原因（stderr/app_logs 仍保留历史，
        # 这里只管当前在途标记的展示；失败原因回写见下方 except）。
        await _set_last_error(session, None)
        # gap 模式：本批入批即 attempts+1（护栏二，达阈值置 exhausted）。
        # 与清 last_error 同批提交——即便下面回补失败/熔断，这一轮尝试也已被计数，
        # 避免同一批洞在数据源长期无数据时被无限重试、每天白烧额度。
        if gap_active:
            await _bump_gap_attempts(session, pending)
        await session.commit()
        # 世代标记快照：本批次开始前取一次，**同一个值**既传给 backfill_historical（供循环内
        # 取消检查），也用于下方「收尾二次校验」。**不**在判定处现取
        # ``settings.price_backfill_run_token``——该 ORM 对象在函数内会被 refresh / rollback
        # 影响（如某只失败时 backfill_historical 内部 rollback 会使其过期），现取可能与本批
        # 实际使用的值不一致，且过期态属性访问有 MissingGreenlet 风险。
        run_token = settings.price_backfill_run_token
        try:
            batch_note = await engine.backfill_historical(
                session,
                itf,
                pending,
                start_date,
                force=force,
                replace=rebuild_active,
                # 世代标记：让在途任务能在循环里识别「自己已被取消 / 被新一次触发取代」，
                # 从而协作式中止（详见 backfill_historical 的取消检查点）。
                run_token=run_token,
                adjust=(settings.price_backfill_adjust or ""),
            )
        except RuntimeError as exc:
            # 熔断/接口不可达：把失败原因回写 settings，供前端在「在途」旁直接展示；
            # 仍重抛，使 track_task 的 app_logs 落库链路（core/bg.py）继续生效。
            # 用原始 UPDATE 而非 ORM 对象：backfill_historical 内部已 rollback，
            # 避免依赖可能过期的会话对象状态。
            await _set_last_error(session, str(exc)[:512])
            await session.commit()
            raise
        # gap 模式：清掉本批已填上的洞（洞即数据本身，补上即删、不留终态）；
        # 未填上的保持 pending，attempts 已在入批时 +1，达阈值即 exhausted（护栏二）。
        if gap_active:
            await reconcile_price_backfill_gaps(session)
            await session.commit()
        # rebuild 模式：本批**成功**后推进游标到最后一个 master_id（按 master_id 升序），
        # 下一批从这里继续。以下**任一**情形都不推进游标：
        # ① 熔断 / 异常：上面 except 直接抛出，走不到这里；
        # ② 协作式中止（取消 / 被新一次触发取代）：backfill_historical 优雅 return
        #    ``AbortSummary``（不抛异常），据 isinstance 显式排除；
        # ③ **收尾期间世代标记才失效**（残余窗口）：取消恰好落在「最后一只证券抓取期间」时，
        #    三个检查点都覆盖不到——①在「每只开始前」（那时尚未取消）、②只在退避 sleep 之后
        #    （成功不经过）、③只在批间冷却（最后一批之后无下一批）——于是 backfill_historical
        #    走正常完成分支、返回普通 str。此窗口只能靠这里**二次校验世代标记**闭合：
        #    非中止**且**标记仍有效才推进。
        # 为什么必须闭合：中止后仍推进会覆盖 DELETE 端点清 ``price_backfill_rebuild_cursor``
        # 的意图（取消即放弃本轮重抓进度）；且「取消 → 立刻重新触发」时老批次收尾写回的游标
        # 可能被新 run 读到 → 从旧批尾部续跑、跳过池首一段（该段保留旧复权口径），与 rebuild
        #「全量重抓」的目的相悖。``run_token`` 为 None（非在途链路）时
        # ``_backfill_run_still_valid`` 恒为 True → 照旧推进，零行为变更。
        if (
            rebuild_active
            and not isinstance(batch_note, AbortSummary)
            and await _backfill_run_still_valid(session, run_token)
        ):
            settings.price_backfill_rebuild_cursor = pending[-1]
            await session.commit()
        # 每 burst 递增当日已用已由 backfill_historical 内结算（成败都计）；此处刷新内存对象
        # 以回显累计值（在途任务期间前端每 3s 轮询 settings 即可看到实时进度）。
        await session.refresh(settings)
        # 剩余额度按**刷新后**的已用值重算：上面那个 remaining 是本批开始前的旧值，
        # 直接回显会与「已用 X/quota」不自洽（本批跑完额度已经变了）。
        remaining_after = max(quota - (settings.price_backfill_used_today or 0), 0)
        return (
            f"在途回补本批 {len(pending)} 只（{mode} 模式，今日剩余额度 {remaining_after}，"
            f"已用 {settings.price_backfill_used_today}/{quota}）：{batch_note}"
        )
    finally:
        # 无论成功 / 熔断 / 异常 / 取消，都必须释放租约——否则此后所有回补（含每日续跑）
        # 都会被永久挡住。异常退出（进程被杀）的残留由应用启动流程复位兜底。
        await _release_backfill_lease(session)
