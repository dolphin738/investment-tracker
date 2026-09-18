"""历史回补**引擎**：抓取-退避-熔断主循环 + 配额记账（决策 A15 / 附录 A.11）。

自 ``market_daily_price_sync`` 抽出（《架构治理规范》§4：存量超限文件禁止继续增长）。
职责边界：只承载「历史回补执行本身」——

- ``backfill_historical``：akshare ``stock_zh_a_hist`` 逐只回补主循环（burst + 批间冷却 +
  指数退避 + 连续失败熔断 + 协作式取消检查点），断点即数据本身；
- 配额记账三函数 ``_bump_used_today`` / ``_commit_burst_quota`` / ``_set_last_error``
  （写 ``dividend_yield_settings`` 单行表，供引擎与在途回补编排共用）；
- 6 个回补限速/熔断常量（``_BACKFILL_*``）。

⚠️ **这 6 个 ``_BACKFILL_*`` 常量必须集中在本模块**：
``backfill_historical`` 运行期读取的是**本模块**命名空间里的常量，故
``monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_*", v)`` 才能命中；
门面 ``market_daily_price_sync`` **严禁** re-export 它们与 ``backfill_historical``，
否则 patch 只改门面命名空间、会**静默失效**（测试照绿但逻辑未被测到）。

入库走 ``market_daily_price_writer._upsert_hist_rows``（本模块只调用、不定值）。
"""
from __future__ import annotations

import asyncio
import logging
import random
import re
from datetime import date, datetime, timedelta
from typing import Optional

from sqlalchemy import inspect, select, text

from app.core.date_utils import today_app_tz
from app.db.database import AsyncSessionLocal
from app.models import MarketSecurityDailyPrice, QuoteInterface, Security
from app.services.market_data_sync import MarketDataSyncService
from app.services.market_daily_price_writer import _upsert_hist_rows
from app.services.market_price_backfill_lease import (
    _abort_summary,
    _backfill_run_still_valid,
    _sleep_with_cancel_check,
)
from app.services.response_fields import (
    SLOT_DATE,
    SLOT_PRICE,
    index_by_slot,
    resolve_fields,
)

# 回补限速与批量常量（决策 A15 / 附录 A.11）：burst≈10 只 + 冷却 60–120s + 指数退避。
_BACKFILL_BURST = 10
_BACKFILL_COOLDOWN_MIN = 60.0
_BACKFILL_COOLDOWN_MAX = 120.0
_BACKFILL_BACKOFFS = (60, 120, 300)  # 指数退避重试间隔（秒），依次用尽即放弃该证券
# 连续失败熔断阈值：连续失败只数达到该值即中止整轮（抛 RuntimeError）。
# 背景：数据源主机 push2his.eastmoney.com 会对本机 IP 定向拒连（0.2 秒内立即失败，
# 非超时），而单只失败时退避重试共耗时约 60+120+300=480 秒。一旦被定向拒连，整轮会
# 按每只约 480 秒的速度空转（4609 只全拒即白等约 614 小时）。连续 N 只失败即认定数据源
# 不可达，立刻中止止损，避免长时间空转。取 3 是「最快止损」与「容忍偶发抖动」的折中：
# 实测定向拒连时第 1 只即失败，故 3 只足以判定；而退避重试已内含 3 次自身重试，
# 单只偶发网络故障不会轻易凑满连续 3 只。
_BACKFILL_FAILURE_BREAKER = 3
# 单只回补请求的兜底超时上界（秒）。实库「东财-历史行情」接口 timeout 列为 NULL，
# _fetch_sdk_raw 内部 wait_for(timeout=None) 即不设超时，单只卡死会无限拖住整轮回补；
# 此层是回补自己的兜底上界，超时后由 except Exception 退避重试，让循环继续推进。
_BACKFILL_FETCH_TIMEOUT = 60.0

logger = logging.getLogger(__name__)


async def backfill_historical(
    session,
    itf: QuoteInterface,
    master_ids: list[str],
    start_date: date,
    *,
    force: bool = False,
    replace: bool = False,
    run_token: Optional[str] = None,
    adjust: str = "",
) -> str:
    """用 akshare ``stock_zh_a_hist`` 回补证券历史日线，按证券独立 commit、断点续跑。

    - ``itf`` 须为配置好的 SDK 行情接口（endpoint=``stock_zh_a_hist``），access_method=sdk；
    - ``adjust``（'' 不复权 | qfq 前复权 | hfq 后复权）为 akshare 复权方式入参，
      由全局配置 ``price_backfill_adjust`` 驱动（历史口径硬编码 ''，现改为可配）；
    - 断点即数据本身：进度 = 该证券在 ``market_security_daily_prices`` 已存在的最早
      ``trade_date``，起点已覆盖 ``start_date`` 的证券跳过（无额外游标表）；
      ``force=True``（严格补洞 gap 模式）时**不做该跳过**——洞恰恰出现在「起点已覆盖」
      的证券上，不强制重抓同一区间就永远填不上；
    - ``replace=True``（全量重抓 rebuild 模式）时**清空后重建**：窗口下限取
      ``min(start_date, 该证券已有最早 trade_date)``，写入前先删除该窗口内的全部既有日线，
      再整段写入本次抓到的行——目的是「不留旧数据」：源如今给不到的日期（停牌、源缺失）
      宁可空缺，也不残留旧源/旧复权口径的值。**抓取窗口同步下探到同一下限**（见循环内
      ``effective_start``）：源不会返回早于配置起点的那段，不同宽下探就会「删了补不回来」，
      形成净数据丢失。与 ``force`` 的区别：``force`` 只是「不跳过」（仍为覆盖式 upsert，
      未返回的日期原样保留），``replace`` 才是清空重写。源返回空 / 全部行解析失败时
      **不删**，见 ``_upsert_hist_rows``（避免空响应误清该证券整段数据且无从恢复）；
    - ``run_token``（在途回补的世代标记，迁移 0024）非空时启用**协作式取消**：在「每只证券
      开始前」「退避 sleep 之后」「批间冷却分片之间」复查该标记，一旦与启动时快照不一致
      （被取消 → NULL；被新一次触发取代 → 另一个 UUID）即**优雅中止**——已写入的行保留、
      剩余证券不再抓取、**不抛异常**（避免被当成失败写 ``last_error``）。为 ``None`` 表示
      非在途链路（如定时任务按 ``backfill_start`` 参数直接调用），**不做世代标记检查**
      （该路径的并发互斥由执行租约保证，见 ``_run_backfill``），零行为变更；
    - burst≈10 只/批 + 批间冷却 60–120s + 指数退避 60/120/300s（决策 A15），每批记进度日志；
    - 单只回补请求另有兜底超时上界 ``_BACKFILL_FETCH_TIMEOUT``（秒），防止接口 timeout=NULL
      时单只卡死无限拖住整轮回补（超时由退避重试分支接住）；
    - 连续失败熔断：连续 ``_BACKFILL_FAILURE_BREAKER`` 只失败即中止整轮并抛 ``RuntimeError``
      （数据源被定向拒连时止损，避免按每只约 480 秒的退避速度长时间空转）。熔断发生在批中途、
      不等本批跑完；中止不影响断点续跑（进度由数据本身决定，重跑自动跳过已覆盖的证券，
      已写入行保留、幂等可续）。
    """
    # 在循环前锁定数据源名称，避免单只失败后 session.rollback() 使 itf 属性过期、
    # 后续成功分支再读 itf.name 触发惰性重载（异步会话下报 MissingGreenlet）。
    # itf 其余属性（provider_id / endpoint / timeout）由循环内的「按需 refresh」保障，见下。
    source = itf.name
    # 同理，在循环前一次性解析出 date/price 槽位字段：resolve_fields 读的是
    # itf.response_fields（普通映射列属性，不触库），但单只失败时循环内会
    # session.rollback() → itf 过期 → 那时再读同样会 MissingGreenlet。故必须放在循环**外**。
    # 未声明 date/price 槽时取 None，由 _upsert_hist_rows 兜底旧中文列名（存量 SDK 接口兼容）。
    _fields = index_by_slot(resolve_fields(itf, include_legacy_code_fallback=False))
    hist_date_field = _fields.get(SLOT_DATE)
    hist_price_field = _fields.get(SLOT_PRICE)
    today = today_app_tz()
    # 抓取窗口下限改为逐只计算（见循环内 effective_start）：rebuild 会按该证券已有最早日期下探。
    end_fmt = today.strftime("%Y%m%d")
    total = len(master_ids)
    done = 0
    skipped = 0
    failed = 0
    written = 0
    consecutive_failures = 0  # 连续失败计数，达到阈值即熔断中止整轮

    for start in range(0, total, _BACKFILL_BURST):
        for mid in master_ids[start : start + _BACKFILL_BURST]:
            # 取消检查点 ①：每只证券开始前。放在「每只」而非「每批」——一个 burst 是 10 只，
            # 放批首会让取消最长多等一整批（数分钟）。
            if not await _backfill_run_still_valid(session, run_token):
                await _commit_burst_quota(
                    session, len(master_ids[start : start + _BACKFILL_BURST])
                )
                return _abort_summary(done, written, skipped)
            sec = await session.get(Security, mid)
            if sec is None:
                # 不重置 consecutive_failures：该分支未发任何请求，不携带连通性信息，
                # 重置会掩盖真实的连续失败趋势、削弱熔断。
                done += 1
                continue
            # 断点即数据本身（P1-3）：已有最早 trade_date ≤ start_date ⇒ 起点已覆盖，跳过。
            # 勿用 max(trade_date)——若日线任务先跑了近期数据，latest=today ≥ start_date
            # 会把中间历史空洞的证券全部误跳过，空洞永不回填。
            # force（gap 模式）例外：洞就在「起点已覆盖」的证券上，必须强制重抓。
            earliest = (
                await session.execute(
                    select(MarketSecurityDailyPrice.trade_date)
                    .where(MarketSecurityDailyPrice.master_id == mid)
                    .order_by(MarketSecurityDailyPrice.trade_date.asc())
                    .limit(1)
                )
            ).scalar_one_or_none()
            if not force and earliest is not None and earliest <= start_date:
                # 不重置 consecutive_failures：该分支仅按已存数据跳过、未发任何请求，
                # 不携带连通性信息，重置会掩盖真实的连续失败趋势、削弱熔断。
                done += 1
                skipped += 1
                continue
            # 窗口下限：rebuild（replace）下扩到「该证券库里已有最早日期」——早于配置起点的旧口径
            # 数据若不清除，「不留旧数据」就落空；而源不会返回那段，故**抓取窗口必须同宽下探**，
            # 否则会出现「删了却补不回来」的净数据丢失（删除与抓取两处必须一起改，勿只改其一）。
            # 非 replace 模式 effective_start 恒 == start_date，与改动前完全一致（零行为变更）。
            effective_start = start_date
            if replace and earliest is not None and earliest < effective_start:
                effective_start = earliest
            params = {
                # akshare stock_zh_a_hist 的 symbol 须为纯数字代码（如 600519），
                # Security.code 带交易所前缀（sh600519），须剥离（P2-2，对照 notice_scan）。
                "symbol": re.sub(r"\D", "", sec.code),
                "start_date": effective_start.strftime("%Y%m%d"),
                "end_date": end_fmt,
                "adjust": adjust,
            }
            # 上一只失败时上面的 `session.rollback()` 会让**外层会话**的所有 ORM 对象过期
            # （`expire_on_commit=False` 只挡 commit，挡不住 rollback）。而接下来
            # `_fetch_sdk_raw` 会读 itf.provider_id / itf.endpoint / itf.timeout —— 一旦 itf
            # 处于过期态，这些同步属性访问就会触发**外层会话**的惰性加载，在独立会话 fs 的
            # 上下文里复现 MissingGreenlet，成为「假连续失败熔断」的另一条触发路径
            #（原实现只快照了 itf.name，漏了这三个）。故此处按需刷新回新鲜态；未过期则零额外查询。
            if inspect(itf).expired:
                await session.refresh(itf)
            hist_written = 0
            succeeded = False
            for attempt, wait in enumerate(_BACKFILL_BACKOFFS, start=1):
                try:
                    # 单只「抓取」用独立会话 fs 执行：akshare 经 asyncio.to_thread 失败时，
                    # 被 asyncio.wait_for 包裹的共享会话 greenlet 上下文会被破坏（见本次回补
                    # sh688115 / sz000830 的 greenlet_spawn has not been called 报错），导致
                    # 后续每只证券首个 session 操作即崩、整轮回补被假「连续失败」熔断。抓取与
                    # 入库解耦：抓取走 fs，异常时随 async with 退出自动关闭/回滚、不污染外层会话；
                    # 入库（_upsert_hist_rows + commit）仍走外层共享会话，保证断点续跑与测试可见性。
                    # 诚实局限：内部 asyncio.to_thread 无法真正取消已启动线程，超时只是让
                    # 回补循环继续推进，底层 HTTP 请求可能仍在后台跑完。
                    async with AsyncSessionLocal() as fs:
                        fmds = MarketDataSyncService(fs)
                        rows = await asyncio.wait_for(
                            fmds._fetch_sdk_raw(itf, params, codes=None),
                            timeout=_BACKFILL_FETCH_TIMEOUT,
                        )
                except Exception as exc:  # noqa: BLE001  退避重试
                    logger.warning(
                        "回补 %s 第 %d/%d 次失败 %s，%ds 后重试",
                        sec.code, attempt, len(_BACKFILL_BACKOFFS), exc, wait,
                    )
                    await asyncio.sleep(wait)
                    # 取消检查点 ②：退避睡眠之后。退避合计最长 60+120+300=480s，
                    # 若只在「每只开始前」检查，取消最长要等一整轮退避跑完。
                    if not await _backfill_run_still_valid(session, run_token):
                        await _commit_burst_quota(
                            session, len(master_ids[start : start + _BACKFILL_BURST])
                        )
                        return _abort_summary(done, written, skipped)
                    continue
                hist_written = await _upsert_hist_rows(
                    session, mid, rows, source,
                    date_field=hist_date_field, price_field=hist_price_field,
                    # rebuild 模式：清空 [窗口下限, 今天] 后重建（不留旧源/旧复权口径的数据）；
                    # 下限 effective_start 已按「该证券已有最早日期」下探，与上面 params 同宽。
                    # 其余模式恒 None → 纯 upsert，绝不删既有行。
                    replace_window=(effective_start, today) if replace else None,
                )
                await session.commit()
                written += hist_written
                succeeded = True
                consecutive_failures = 0  # 单只成功：清零连续失败计数
                break
            if not succeeded:
                failed += 1
                consecutive_failures += 1
                await session.rollback()
                # 连续失败达到阈值：判定数据源被定向拒连，立即中止整轮止损
                # （中止发生在批中途，不等本批 10 只跑完）。
                if consecutive_failures >= _BACKFILL_FAILURE_BREAKER:
                    logger.error(
                        "回补连续失败熔断：连续失败 %d 只 ≥ 阈值 %d，进度 %d/%d，"
                        "已跳过 %d 只，已写入 %d 行，中止整轮",
                        consecutive_failures, _BACKFILL_FAILURE_BREAKER,
                        done + 1, total, skipped, written,
                    )
                    # 熔断中止前补记**本批**额度：循环末尾那句 burst 记账在 raise 之后不会执行，
                    # 不补记会让熔断批整体漏计（当日额度被低估，与「成败都计」口径不符）。
                    # 与末尾同口径：按本批分配只数计（含跳过/失败）。
                    await _commit_burst_quota(
                        session, len(master_ids[start : start + _BACKFILL_BURST])
                    )
                    raise RuntimeError(
                        f"回补连续失败熔断：连续失败 {consecutive_failures} 只"
                        f"（阈值 {_BACKFILL_FAILURE_BREAKER}），进度 {done + 1}/{total}，"
                        f"已写入行 {written}。已写入数据保留，可重跑续跑（幂等）。"
                        f"请检查数据源 push2his.eastmoney.com 是否对本机 IP 定向拒连。"
                    )
            done += 1
        # 每 burst 一批递增当日已用额度（成败都计）：本 burst **分配只数**（含跳过/失败）计入，
        # 满足额度口径（单只失败不计时会导致同日额度被反复重试刷爆）。
        # 用同一 session 但**立即 commit**：记账一旦落库就不再受后续日线写入 rollback 的抹除
        #（并非独立事务/连接；单行表契约与原子性说明见 _bump_used_today）。
        burst_n = len(master_ids[start : start + _BACKFILL_BURST])
        await _bump_used_today(session, burst_n)
        await session.commit()
        # 批间冷却（决策 A15：60–120s，随机抖动），最后一批跳过
        if start + _BACKFILL_BURST < total:
            cooldown = random.uniform(_BACKFILL_COOLDOWN_MIN, _BACKFILL_COOLDOWN_MAX)
            next_at = (datetime.now() + timedelta(seconds=cooldown)).strftime("%H:%M")
            logger.info("已回补 %d/%d，下一冷却到 %s（%.0fs）", done, total, next_at, cooldown)
            # 取消检查点 ③：批间冷却分片复查 —— 整段 sleep 会让取消最长等 120s。
            # 注意本 burst 额度已在上面记账，此处中止**不再**补记（避免双计）。
            if await _sleep_with_cancel_check(session, run_token, cooldown):
                return _abort_summary(done, written, skipped)
        else:
            logger.info("已回补 %d/%d，回补结束", done, total)

    return (
        f"历史回补完成：处理 {total} 只，新增/更新行 {written}，跳过 {skipped} 只（已完成），"
        f"失败 {failed} 只"
    )


async def _bump_used_today(session, n: int) -> None:
    """把当日已用回补额度原子递增 ``n``（成败都计）。

    契约：``dividend_yield_settings`` 是**全局单行配置表**（恒 1 行），
    故此处 UPDATE **故意不带 WHERE**；若未来该表改为多行语义（多租户/多档配置），
    必须补 ``WHERE`` 限定，否则会波及全部行。

    原子 UPDATE 自带行锁；调用方随后立即 commit，使这笔记账**不再受后续日线写入
    rollback 的抹除**（注意：用的是同一个 session，并非独立事务/连接）。
    """
    await session.execute(
        text(
            "UPDATE dividend_yield_settings "
            "SET price_backfill_used_today = COALESCE(price_backfill_used_today, 0) + :n"
        ),
        {"n": n},
    )


async def _commit_burst_quota(session, burst_n: int) -> None:
    """把本 burst 的**分配只数**计入当日额度并立即提交（成败都计）。

    与 ``_bump_used_today`` 的区别只是「提交 + 吞掉记账异常」：
    中止路径（熔断 / 取消 / 被取代）上，记账失败不得掩盖真正的中止原因，故仅告警。
    """
    try:
        await _bump_used_today(session, burst_n)
        await session.commit()
    except Exception:  # noqa: BLE001
        await session.rollback()
        logger.warning("回补额度记账失败（不影响本次中止原因）", exc_info=True)


async def _set_last_error(session, message: Optional[str]) -> None:
    """写/清回补失败原因（``message=None`` 表示清空）。

    契约同 ``_bump_used_today``：目标是恒单行的全局配置表，故 UPDATE 故意不带 WHERE。
    用原始 SQL 而非 ORM 赋值，是为了在会话对象可能已过期的异常路径上也能安全写入。
    """
    await session.execute(
        text("UPDATE dividend_yield_settings SET price_backfill_last_error = :e"),
        {"e": message},
    )
