"""每日收盘价采集 + 历史回补服务（方案 §6.2）。

- ``market_daily_close_fetch``：每交易日 15:05 抓取选定「证券行情」（分类 2）接口当天收盘价，
  幂等 upsert 到 ``market_security_daily_prices``。复用 ``market_data_sync`` 既有
  ``_call_interface_raw`` / ``_row_get`` / ``_normalize_master_code`` / 告警链路，不重写请求。
  双防线防节假日/停牌污（决策 A9）：交易日历校验（主）+ 返回日期比对（备）。
- ``backfill_historical``：历史日线回补（akshare ``stock_zh_a_hist``，决策 A15），
  单独方法供复用，本阶段不注册为任务默认调用（防日线任务无限拉历史）。断点即数据本身。

组装 handler ``run_market_daily_close_fetch`` 供 scheduler 注册（独立会话）。
"""
from __future__ import annotations

import asyncio
import logging
import random
import re
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

from sqlalchemy import exists, func, inspect, select, text
from sqlalchemy import delete as sa_delete

from app.core.date_utils import today_app_tz
from app.db.database import AsyncSessionLocal
from app.models import (
    GAP_STATUS_EXHAUSTED,
    GAP_STATUS_PENDING,
    PRICE_BACKFILL_MODE_GAP,
    PRICE_BACKFILL_MODE_LEGACY,
    PRICE_BACKFILL_MODE_REBUILD,
    DividendYieldSettings,
    MarketPriceBackfillGap,
    MarketSecurityDailyPrice,
    QuoteInterface,
    SecuritiesDataProvider,
    Security,
    SecurityDividend,
)
from app.models.enums import QuoteProviderAccessMethod
from app.services.market_data_sync import (
    QUOTE_CAT_ID,
    MarketDataSyncService,
    _normalize_master_code,
    infer_exchange,
)
from app.services.response_fields import (
    SLOT_CODE,
    SLOT_DATE,
    SLOT_PRICE,
    index_by_slot,
    resolve_fields,
)
from app.services.response_path import CompiledField
from app.core.date_utils import parse_date
from app.services.dividend_yield_refresh import (
    is_trade_day,
    refresh_yields_for_masters,
    update_stale_flags,
)

from app.services.market_price_backfill_gaps import (
    _GAP_MAX_ATTEMPTS,
    _bump_gap_attempts,
    clear_price_backfill_gaps as clear_price_backfill_gaps,
    reconcile_price_backfill_gaps,
    sync_price_backfill_gaps,
)
from app.services.market_price_backfill_lease import (
    AbortSummary,
    _BACKFILL_LEASE_WAIT_SECONDS as _BACKFILL_LEASE_WAIT_SECONDS,
    _abort_summary,
    _acquire_backfill_lease,
    _backfill_run_still_valid,
    _release_backfill_lease,
    _sleep_with_cancel_check,
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

# 旧列兜底：仅用于**未声明** date/price 槽的历史 SDK 接口（未配置 response_fields 时的
# 旧列合成路径，此时 date 槽为空）。新注册接口应声明 date/price 槽，取值走 resolve_fields；
# 此处中文列名不再写死使用。
_COL_HIST_DATE = "日期"
_COL_HIST_CLOSE = "收盘"

logger = logging.getLogger(__name__)


async def reset_backfill_lease() -> None:
    """把回补执行租约（``price_backfill_running``）复位为 false。

    兜底场景：进程在回补执行期间被强杀 / 崩溃，租约会残留 true，此后**所有**回补
    （含每日收盘价抓取的续跑）都会被永久挡住。启动时此刻本进程必无任何回补在跑，
    无条件复位是安全的。

    失败只告警不阻断：迁移 0024 尚未执行时该列不存在（老环境滚动升级的中间态），
    不该让应用起不来。
    """
    try:
        async with AsyncSessionLocal() as session:
            await session.execute(
                text(
                    "UPDATE dividend_yield_settings SET price_backfill_running = false"
                )
            )
            await session.commit()
    except Exception:  # noqa: BLE001  复位失败不阻断启动（列可能尚未迁移）
        logging.getLogger(__name__).warning(
            "回补执行租约复位失败（不阻断启动，但若残留 true 会挡住回补）",
            exc_info=True,
        )


class MarketDailyPriceSyncService:
    """每日收盘价采集（复用 market_data_sync 请求/主数据机制）。"""

    def __init__(self, session) -> None:
        self.session = session
        self._mds = MarketDataSyncService(session)

    # ------------------------------------------------------------------ #
    # 配置读取（§6.5：行情源 = price_source_interface_id，分类 2，enabled）
    # ------------------------------------------------------------------ #
    async def _settings(self) -> Optional[DividendYieldSettings]:
        return (
            await self.session.execute(select(DividendYieldSettings).limit(1))
        ).scalar_one_or_none()

    async def _resolve_quote_interface(self, settings) -> Optional[QuoteInterface]:
        """解析行情源接口（存在性 + 分类 2 归属 + enabled），无效返回 None 由调用方 fail fast。"""
        interface_id = settings.price_source_interface_id if settings is not None else None
        if not interface_id:
            return None
        itf = await self.session.get(QuoteInterface, interface_id)
        if itf is None or itf.category_id != QUOTE_CAT_ID or not itf.enabled:
            return None
        return itf

    async def _code_map(self) -> dict[str, str]:
        """代码清单：``security_dividends`` 去重 master_id → Security.code（已带交易所前缀）。

        返回 ``{normalized_code: master_id}``，不依赖全市场主数据同步（§1.3 覆盖度语义）。
        """
        mids = set(
            (
                await self.session.execute(select(SecurityDividend.master_id).distinct())
            ).scalars().all()
        )
        if not mids:
            return {}
        rows = (
            await self.session.execute(select(Security).where(Security.id.in_(mids)))
        ).scalars().all()
        return {s.code: s.id for s in rows}

    async def _fetch_batch_guarded(
        self, itf: QuoteInterface, params, codes: list[str]
    ) -> Optional[list]:
        """批次拉取 + 返回行数校验（缺数重试一次；整体为 0 则整批丢弃返回 None）。"""
        for attempt in (0, 1):
            try:
                rows = await self._mds._call_interface_raw(itf, params, codes=codes)
            except Exception as exc:  # noqa: BLE001  请求异常走重试
                logger.warning("收盘价批次 %d 只请求异常 %s，重试", len(codes), exc)
                if attempt == 0:
                    continue
                return None
            if not rows and codes:
                return None  # 整体为 0 且清单非空 → 整批跳过（调用方告警）
            if len(rows) != len(codes):
                logger.warning("批次返回 %d 条 != 请求 %d 条", len(rows), len(codes))
                if attempt == 0:
                    continue  # 缺数重试一次（不静默丢价）
            return rows  # 重试后仍缺数：不丢已返回行，按行继续 upsert
        return None

    # ------------------------------------------------------------------ #
    # 共享：单日横截面写入（§6.2 日抓 + 路线 A 缺口回补共用）
    # ------------------------------------------------------------------ #
    async def _write_one_day(
        self,
        itf: QuoteInterface,
        code_map: dict[str, str],
        target: date,
        *,
        expect_date: bool,
    ) -> tuple[set[str], int, int, int]:
        """抓取 ``target`` 日全市场收盘价并幂等 upsert。

        日抓与缺口回补**唯一差异**在日期校验语义，故收敛到本方法：

        - 日抓（``expect_date=True``）：防线二按「返回日期 == ``target``」全等比较，
          停牌股/节假日污染整批拦下（决策 A9，§6.2 原语义不变）；
        - 缺口回补（``expect_date=False``）：接口只返回**当前价**，其日期字段是「今天」，
          与待补的 ``target`` 必然不等，若仍做全等比较则**每批都被拦下、回补永不生效**。
          故此处只校验「该日期字段可解析」——它仍能拦下节假日整批空响应，
          但不再用它比对目标日（目标日由调用方的已存档日期枚举保证）。

        返回 ``(changed_master_ids, 成功批次, 失败批次, 写入行数)``。
        """
        rp = itf.response_parse or {}
        batch_size = max(1, int(rp.get("max_codes_per_request", 800) or 800))
        # code 槽禁用 F4 中文兜底，与 HEAD（接口配置的代码列 or "code"）等价（行情用途 cat=2
        # 本无兜底，此处为显式一致）；required 槽缺失整行丢弃 + 计数（边界 6）。
        compiled = resolve_fields(itf, include_legacy_code_fallback=False)
        fields = index_by_slot(compiled)
        date_field = fields.get(SLOT_DATE)
        code_field = fields.get(SLOT_CODE)
        price_field = fields.get(SLOT_PRICE)
        codes = list(code_map.keys())

        # 预取目标日已存在行，作为同日重抓覆盖 close 的幂等 upsert 基础
        existing = {
            r.master_id: r
            for r in (
                (
                    await self.session.execute(
                        select(MarketSecurityDailyPrice).where(
                            MarketSecurityDailyPrice.trade_date == target
                        )
                    )
                )
                .scalars()
                .all()
            )
        }
        fetched_at = datetime.now(timezone.utc)
        changed: set[str] = set()
        success_batches = 0
        failed_batches = 0
        total_rows = 0

        for start in range(0, len(codes), batch_size):
            batch = codes[start : start + batch_size]
            rows = await self._fetch_batch_guarded(itf, itf.params, batch)
            if rows is None:
                failed_batches += 1
                logger.warning(
                    "%s批次 %d 只整批丢弃", target.isoformat(), len(batch)
                )
                continue
            # required 槽缺失整行丢弃 + 计数（边界 6）；整批被丢 = 无可用响应，
            # 复用既有 consecutive_failures/alerted 失败计数通道（不新造告警）。
            batch_total = len(rows)
            rows, dropped = self._mds._filter_required_rows(itf, compiled, rows)
            if not rows:
                await self._mds._note_required_drops(itf, dropped, batch_total)
                failed_batches += 1
                continue
            # 防线二：返回日期比对（§6.2——返回日期 ≠ 目标日即整批跳过，节假日/停牌防污。
            # 同批混有停牌股（返回上一交易日日期）时也必须拦下，故收紧为全等比较）
            if date_field is not None and expect_date:
                dates = {parse_date(date_field.get(r)) for r in rows}
                dates.discard(None)
                if dates and dates != {target}:
                    logger.warning(
                        "批次返回日期 %s ≠ 目标日 %s，整批跳过",
                        sorted(dates),
                        target.isoformat(),
                    )
                    failed_batches += 1
                    continue
            batch_written = self._upsert_day_rows(
                rows, code_map, target, existing, itf.name, fetched_at,
                code_field=code_field, price_field=price_field, changed=changed,
            )
            if batch_written > 0:
                success_batches += 1
                total_rows += batch_written

        return changed, success_batches, failed_batches, total_rows

    def _upsert_day_rows(
        self,
        rows: list[Any],
        code_map: dict[str, str],
        target: date,
        existing: dict[str, MarketSecurityDailyPrice],
        source: str,
        fetched_at: datetime,
        *,
        code_field: Optional[CompiledField],
        price_field: Optional[CompiledField],
        changed: set[str],
    ) -> int:
        """原始行 → ``market_security_daily_prices`` 幂等 upsert，返回本批写入行数。

        同 ``existing`` 内已有 (master_id, target) 行则覆盖 close/source/fetched_at，
        否则新增；已在 ``existing`` 缓存的行同步更新，保证同批多次命中不重复 add。
        """
        written = 0
        for r in rows:
            raw_code = code_field.get(r) if code_field else None
            if raw_code is None:
                continue
            code = _normalize_master_code(str(raw_code), infer_exchange(str(raw_code)))
            master_id = code_map.get(code)
            if master_id is None:
                continue  # 未命中 master，跳过该行
            raw_close = price_field.get(r) if price_field else None
            if raw_close is None:
                continue
            try:
                close = Decimal(str(raw_close))
            except (InvalidOperation, ValueError, TypeError):
                continue
            row = existing.get(master_id)
            if row is None:
                row = MarketSecurityDailyPrice(
                    master_id=master_id,
                    trade_date=target,
                    close=close,
                    source=source,
                    fetched_at=fetched_at,
                )
                self.session.add(row)
                existing[master_id] = row
            else:
                row.close = close
                row.source = source
                row.fetched_at = fetched_at
            changed.add(master_id)
            written += 1
        return written

    # ------------------------------------------------------------------ #
    # 每日收盘价抓取（§6.2）
    # ------------------------------------------------------------------ #
    async def daily_close_fetch(self, cfg: Any) -> str:
        """抓取当天收盘价并 upsert；防线失败/无效源时抛错、非交易日返回跳过信息。"""
        today = today_app_tz()
        # 防线一：交易日历校验（决策 A9 根本解法；日历空时降级返回 True 交给防线二）
        if not await is_trade_day(self.session, today):
            return "非交易日，跳过当日收盘价抓取"

        settings = await self._settings()
        if settings is None:
            raise RuntimeError("股息率配置表为空，无法执行收盘价抓取")
        itf = await self._resolve_quote_interface(settings)
        if itf is None:
            raise RuntimeError("行情源接口缺失或被停用，fail fast 跳过收盘价抓取")

        code_map = await self._code_map()
        if not code_map:
            return "security_dividends 无证券，跳过收盘价抓取"

        changed, success_batches, failed_batches, total_rows = await self._write_one_day(
            itf, code_map, today, expect_date=True
        )

        stale_count = await update_stale_flags(self.session)  # §7：任务末统一扫描 stale
        if changed:
            await refresh_yields_for_masters(self.session, list(changed))
        await self.session.commit()

        # 历史回补生产入口（P1-3，§6.2/A15）：cfg.params.backfill_start（ISO 日期，如
        # "2021-09-07"）非空时，日抓完成后用行情接口回补历史日线——冷启动回补 5 年 /
        # 中间历史空洞补齐，均可通过普通任务或系统任务配置此参数后手动触发。
        backfill_note = ""
        backfill_start_raw = (getattr(cfg, "params", None) or {}).get("backfill_start")
        if backfill_start_raw:
            backfill_note = await self._run_backfill(
                itf,
                code_map,
                backfill_start_raw,
                adjust=getattr(settings, "price_backfill_adjust", "") or "",
            )

        # 在途回补任务（形态 A）：每日额度分批补完即清空（§6.2 在途任务）。
        # 仅在存在在途任务时调用——无在途任务为纯 no-op（不发请求、不改数据），
        # 否则会打破既有测试。每日批次回补失败须隔离：价格抓取本身已成功，回补熔断/
        # 异常（含 backfill_historical 的 RuntimeError）不应让每日任务整体 FAILED。
        backfill_status = ""
        if getattr(settings, "price_backfill_start_date", None) is not None:
            try:
                backfill_status = await run_pending_price_backfill(self.session)
            except Exception as exc:  # noqa: BLE001  每日批次回补失败隔离，不影响收盘价抓取
                logger.warning("每日额度回补异常（已隔离，不影响收盘价抓取）：%s", exc)
                backfill_status = f"每日额度回补失败：{exc}"

        result = (
            f"收盘价抓取完成：成功批次 {success_batches}，成功行 {total_rows}，"
            f"失败批次 {failed_batches}，重算证券 {len(changed)} 只，"
            f"stale 标记 {stale_count} 行，日期 {today.isoformat()}"
        )
        if backfill_note:
            result += f"；{backfill_note}"
        if backfill_status:
            result += f"；每日额度回补：{backfill_status}"
        return result

    async def _run_backfill(
        self,
        itf: QuoteInterface,
        code_map: dict[str, str],
        backfill_start_raw: str,
        *,
        adjust: str = "",
    ) -> str:
        """解析 backfill_start 并执行历史回补（fail fast 抛错由任务层落 FAILED）。

        ``adjust``（'' 不复权 | qfq 前复权 | hfq 后复权）来自全局配置，透传给
        ``backfill_historical`` 作为 akshare ``stock_zh_a_hist`` 的 ``adjust`` 入参。

        **执行租约（迁移 0024）**：本入口与「手动首批 / 每日续跑」共享同一把回补租约。
        风险场景是**跨调度并发**——管理员手动首批仍在跑（持租约）时，另一个配了
        ``backfill_start`` 的任务被触发——不取租约就会并发抓同一池子、额度双计。
        故校验通过后先抢租约：``timeout=0``（本入口属后台链路，没空位就下次再说，
        与每日续跑同口径，不值得等），抢不到即返回明确说明串、**绝不放行并发**；
        抢到后 ``finally`` 无条件释放（否则此后所有回补都会被永久挡住）。
        """
        try:
            start = date.fromisoformat(str(backfill_start_raw).strip())
        except ValueError as exc:
            raise RuntimeError(
                f"backfill_start 非法（须 ISO 日期 YYYY-MM-DD）：{backfill_start_raw!r}"
            ) from exc
        provider = await self.session.get(SecuritiesDataProvider, itf.provider_id)
        if provider is None or provider.access_method != QuoteProviderAccessMethod.SDK:
            raise RuntimeError(
                "历史回补要求行情接口 access_method=sdk（stock_zh_a_hist），"
                f"当前接口 {itf.name!r} 的提供方不符"
            )
        # 执行租约：与手动首批 / 每日续跑互斥（跨调度并发防护）。抢不到即跳过、不发请求。
        if not await _acquire_backfill_lease(self.session):
            logger.info(
                "回补执行租约已被占用（已有 run 在执行），本次 backfill_start 回补跳过"
            )
            return (
                "已有回补任务正在执行中（同一时刻只允许一个 run），"
                "本次 backfill_start 回补已跳过"
            )
        try:
            master_ids = list(dict.fromkeys(code_map.values()))
            return await backfill_historical(
                self.session, itf, master_ids, start, adjust=adjust
            )
        finally:
            # 无条件释放：正常 / 熔断 / 异常都要还租约，否则回补（含每日续跑）会被永久挡住。
            await _release_backfill_lease(self.session)


# --------------------------------------------------------------------------- #
# 历史日线回补（§6.2 末段 / 决策 A15）——单独方法供复用，不注册为任务默认调用
# --------------------------------------------------------------------------- #
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


async def _upsert_hist_rows(
    session,
    master_id: str,
    rows: list[dict],
    source: str,
    *,
    date_field: Optional[CompiledField] = None,
    price_field: Optional[CompiledField] = None,
    replace_window: Optional[tuple[date, date]] = None,
) -> int:
    """把历史日线返回行写进 ``market_security_daily_prices``，返回写入行数。

    取值优先级：优先按接口声明的 ``date``/``price`` 槽（``resolve_fields`` 编译的
    ``CompiledField``，兼容任意响应列名，如腾讯源的 ``date``/``close``）；未声明对应槽
    （``date_field``/``price_field`` 为 ``None``，存量未配置 ``response_fields`` 的 SDK 接口）
    时兜底旧中文列名（``日期``/``收盘``）。

    ``replace_window``（闭区间 ``(起, 止)``）为 ``rebuild`` 模式的「清空后重建」语义：
    写入前先删除本证券该窗口内的**全部既有日线**，再整段写入本次抓到的行——目的是
    **不留旧数据**：源如今给不到的日期（停牌、源缺失）宁可空缺，也不残留旧源/旧复权
    口径的值。窗口**下限由调用方给出**（``backfill_historical`` 在 replace 下已按该证券
    已有最早日期下探，且抓取窗口同宽），本函数不做计算。``None``（默认，legacy / gap 模式）
    保持纯 upsert：命中即覆盖、未命中才新增，绝不删除既有行。
    """
    if not rows:
        return 0
    trace: dict[date, Decimal] = {}
    for r in rows:
        raw_date = date_field.get(r) if date_field is not None else None
        if raw_date is None:
            raw_date = r.get(_COL_HIST_DATE)
        d = parse_date(raw_date)
        if d is None:
            continue
        raw_close = price_field.get(r) if price_field is not None else None
        if raw_close is None:
            raw_close = r.get(_COL_HIST_CLOSE)
        if raw_close is None:
            continue
        try:
            trace[d] = Decimal(str(raw_close))
        except (InvalidOperation, ValueError, TypeError):
            continue
    if not trace:
        return 0
    if replace_window is not None:
        if trace and min(trace) > replace_window[0]:
            # 源响应疑似头部截断：最早返回日期晚于窗口下限，说明本次回补只拿到了窗口
            # 中后段、窗口头部的更早日线缺失。若整窗删除会把头部既有日线误删且本次补不
            # 回来（净数据丢失），故**只删源已返回的中后段 [min(trace), 窗口上限]**——
            # 该段本就会被整段重建；头部 [窗口下限, min(trace)) 保留旧值，宁可留旧也不
            # 冒险删除后无源可补。
            logging.getLogger(__name__).warning(
                "回补 replace_window 源响应疑似头部截断（最早返回 %s 晚于窗口下限 %s），"
                "保住头部既有日线、仅删中后段，避免误删且无源可补",
                min(trace),
                replace_window[0],
            )
            await session.execute(
                sa_delete(MarketSecurityDailyPrice).where(
                    MarketSecurityDailyPrice.master_id == master_id,
                    MarketSecurityDailyPrice.trade_date >= min(trace),
                    MarketSecurityDailyPrice.trade_date <= replace_window[1],
                )
            )
        else:
            # 清空后重建：先删窗口内既有行（含旧源/旧复权口径的），再整段写入。
            await session.execute(
                sa_delete(MarketSecurityDailyPrice).where(
                    MarketSecurityDailyPrice.master_id == master_id,
                    MarketSecurityDailyPrice.trade_date >= replace_window[0],
                    MarketSecurityDailyPrice.trade_date <= replace_window[1],
                )
            )
    existing = {
        e.trade_date: e
        for e in (
            (
                await session.execute(
                    select(MarketSecurityDailyPrice).where(
                        MarketSecurityDailyPrice.master_id == master_id,
                        MarketSecurityDailyPrice.trade_date.in_(list(trace.keys())),
                    )
                )
            )
            .scalars()
            .all()
        )
    }
    fetched_at = datetime.now(timezone.utc)
    count = 0
    for d, close in trace.items():
        row = existing.get(d)
        if row is None:
            session.add(
                MarketSecurityDailyPrice(
                    master_id=master_id,
                    trade_date=d,
                    close=close,
                    source=source,
                    fetched_at=fetched_at,
                )
            )
        else:
            row.close = close
            row.source = source
            row.fetched_at = fetched_at
        count += 1
    return count


# --------------------------------------------------------------------------- #
# 在途回补任务（形态 A，用户裁决方案）：摊到多天、按每日额度分批、补完即清空终态
# --------------------------------------------------------------------------- #
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


# --------------------------------------------------------------------------- #
# 全量重抓（rebuild）模式：不做覆盖度筛选，按 master_id 游标推进全池重抓
# --------------------------------------------------------------------------- #
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


# --------------------------------------------------------------------------- #
# 严格补洞（gap）模式选批（洞状态表的落库/清理见 market_price_backfill_gaps）
# --------------------------------------------------------------------------- #
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
            batch_note = await backfill_historical(
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


# --------------------------------------------------------------------------- #
# 模块级 handler 入口（供 scheduler 薄注册；独立会话对齐既有 handler 风格）
# --------------------------------------------------------------------------- #
async def run_market_daily_close_fetch(cfg: Any) -> str:
    """每日收盘价抓取 handler。"""
    from app.db.database import AsyncSessionLocal

    async with AsyncSessionLocal() as session:
        result = await MarketDailyPriceSyncService(session).daily_close_fetch(cfg)
    return result