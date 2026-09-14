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
from sqlalchemy import update as sa_update

from app.core.date_utils import today_app_tz
from app.db.database import AsyncSessionLocal
from app.models import (
    GAP_STATUS_EXHAUSTED,
    GAP_STATUS_PENDING,
    PRICE_BACKFILL_MODE_GAP,
    PRICE_BACKFILL_MODE_LEGACY,
    DividendYieldSettings,
    MarketPriceBackfillGap,
    MarketSecurityDailyPrice,
    MarketTradeCalendar,
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
# 严格补洞（gap）模式：单个洞被纳入批次的次数上限。达到该次数仍未被填上 → status 置
# exhausted 并不再入批（护栏二）。取 2 是「容忍一次偶发数据源抖动」与「不无限重试」的折中：
# 首次入批可能因当日额度/网络抖动没跑成，第二次仍填不上基本可判定该日数据确实取不到
# （停牌、退市后无行情等），继续重试只会每天重复消耗额度。
_GAP_MAX_ATTEMPTS = 2

# 旧列兜底：仅用于**未声明** date/price 槽的历史 SDK 接口（未配置 response_fields 时的
# 旧列合成路径，此时 date 槽为空）。新注册接口应声明 date/price 槽，取值走 resolve_fields；
# 此处中文列名不再写死使用。
_COL_HIST_DATE = "日期"
_COL_HIST_CLOSE = "收盘"

logger = logging.getLogger(__name__)


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
        master_ids = list(dict.fromkeys(code_map.values()))
        return await backfill_historical(
            self.session, itf, master_ids, start, adjust=adjust
        )


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
    start_fmt = start_date.strftime("%Y%m%d")
    end_fmt = today.strftime("%Y%m%d")
    total = len(master_ids)
    done = 0
    skipped = 0
    failed = 0
    written = 0
    consecutive_failures = 0  # 连续失败计数，达到阈值即熔断中止整轮

    for start in range(0, total, _BACKFILL_BURST):
        for mid in master_ids[start : start + _BACKFILL_BURST]:
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
            params = {
                # akshare stock_zh_a_hist 的 symbol 须为纯数字代码（如 600519），
                # Security.code 带交易所前缀（sh600519），须剥离（P2-2，对照 notice_scan）。
                "symbol": re.sub(r"\D", "", sec.code),
                "start_date": start_fmt,
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
                    continue
                hist_written = await _upsert_hist_rows(
                    session, mid, rows, source,
                    date_field=hist_date_field, price_field=hist_price_field,
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
                    try:
                        await _bump_used_today(
                            session, len(master_ids[start : start + _BACKFILL_BURST])
                        )
                        await session.commit()
                    except Exception:  # noqa: BLE001  记账失败不得掩盖熔断原因
                        logger.warning(
                            "熔断前回补额度记账失败（不影响熔断判定）", exc_info=True
                        )
                        await session.rollback()
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
            await asyncio.sleep(cooldown)
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
) -> int:
    """把历史日线返回行幂等 upsert 进 ``market_security_daily_prices``，返回写入行数。

    取值优先级：优先按接口声明的 ``date``/``price`` 槽（``resolve_fields`` 编译的
    ``CompiledField``，兼容任意响应列名，如腾讯源的 ``date``/``close``）；未声明对应槽
    （``date_field``/``price_field`` 为 ``None``，存量未配置 ``response_fields`` 的 SDK 接口）
    时兜底旧中文列名（``日期``/``收盘``）。
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
async def _select_pending_backfill_masters(
    session, start_date: date, quota: int
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
    return list((await session.execute(stmt)).scalars().all())


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
    session, start_date: date, today: Optional[date] = None
) -> Optional[int]:
    """按交易日历重算「洞」并落 ``market_price_backfill_gaps``（幂等，只 INSERT 缺失行）。

    洞 = 窗口内的已记录交易日中，该证券 ``market_security_daily_prices`` 没有对应行的日子。

    三条护栏：
    1. **上界 = 昨天**（``upper = today - 1 天``）：今天的日线可能尚未抓取（日线任务 15:05
       才跑），把今天当洞会让每只证券每天必然多出一个「永远填不满」的洞 → 任务永不结束；
    2. **只对「起点已覆盖」的证券记洞**：完全未覆盖的证券由 legacy 分支兜住
       （``_select_gap_backfill_masters`` 取并集），否则「N 只 × 窗口交易日」会瞬间撑爆
       状态表。单只证券的洞行数上界 = 窗口交易日数；
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
                WHERE EXISTS (
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
        {"lo": start_date, "hi": upper, "pending": GAP_STATUS_PENDING},
    )
    # rowcount 防御：-1 是 truthy，`or 0` 兜不住（部分驱动对 INSERT...ON CONFLICT 可能回 -1），
    # 故统一 max(..., 0) 归一到非负计数。
    added = max(int(res.rowcount or 0), 0)
    return added


async def _select_gap_backfill_masters(
    session, start_date: date, quota: int
) -> tuple[list[str], bool]:
    """gap 模式待补名单：``起点未覆盖`` ∪ ``有未耗尽洞``（限 quota 只，按 master_id 排序）。

    返回 ``(master_ids, calendar_ok)``；``calendar_ok=False`` 表示交易日历不覆盖回补窗口、
    无法按洞判定，调用方须回落 legacy（护栏三）。
    """
    synced = await sync_price_backfill_gaps(session, start_date)
    if synced is None:
        return [], False
    # 起点未覆盖（legacy 口径）：兜住完全无数据 / 起点之前无数据的证券
    uncovered = await _select_pending_backfill_masters(session, start_date, quota)
    # 有洞且未耗尽：attempts 达阈值的已置 exhausted，不在此列（护栏二）
    gapped = list(
        (
            await session.execute(
                select(MarketPriceBackfillGap.master_id)
                .where(
                    MarketPriceBackfillGap.status == GAP_STATUS_PENDING,
                    MarketPriceBackfillGap.attempts < _GAP_MAX_ATTEMPTS,
                )
                .distinct()
                .order_by(MarketPriceBackfillGap.master_id)
                .limit(quota)
            )
        )
        .scalars()
        .all()
    )
    return sorted(set(uncovered) | set(gapped))[:quota], True


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


async def run_pending_price_backfill(session) -> str:
    """在途回补任务：按每日额度跑一批未覆盖证券的历史日线；补完即清空在途状态。

    供两处复用：路由 ``POST /backfill-prices`` 首批、每日「收盘价抓取」完成后续跑。

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
    #   交易日历不覆盖回补窗口时无从判定洞 → 回落 legacy（护栏三），不静默空转。
    mode = settings.price_backfill_mode or PRICE_BACKFILL_MODE_LEGACY
    force = False  # gap 模式须强制重抓（洞就在「起点已覆盖」的证券上）
    gap_active = False
    if mode == PRICE_BACKFILL_MODE_GAP:
        pending, calendar_ok = await _select_gap_backfill_masters(
            session, start_date, remaining
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
                session, start_date, remaining
            )
    else:
        pending = await _select_pending_backfill_masters(session, start_date, remaining)

    if not pending:
        # 全部已覆盖 → 补完，清空在途状态（终态），此后不再跑。
        # 终态不再静默：gap 模式下把已放弃（exhausted）的洞数一并告知——这些洞是数据源长期
        # 未提供的日期，attempts 达阈值后不再入批；重新触发回补（POST /backfill-prices 会
        # 清空洞表）即可重置状态重试。
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
                    f"；另有 {exhausted_count} 个洞因数据源长期未提供已放弃（exhausted）；"
                    "重新触发回补可重置状态重试"
                )
        settings.price_backfill_start_date = None
        settings.price_backfill_last_error = None
        await session.commit()
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
    try:
        batch_note = await backfill_historical(
            session,
            itf,
            pending,
            start_date,
            force=force,
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


# --------------------------------------------------------------------------- #
# 模块级 handler 入口（供 scheduler 薄注册；独立会话对齐既有 handler 风格）
# --------------------------------------------------------------------------- #
async def run_market_daily_close_fetch(cfg: Any) -> str:
    """每日收盘价抓取 handler。"""
    from app.db.database import AsyncSessionLocal

    async with AsyncSessionLocal() as session:
        result = await MarketDailyPriceSyncService(session).daily_close_fetch(cfg)
    return result