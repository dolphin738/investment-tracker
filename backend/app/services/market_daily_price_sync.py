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

from sqlalchemy import select

from app.core.date_utils import today_app_tz
from app.models import (
    DividendYieldSettings,
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
    _row_get,
    infer_exchange,
)
from app.services.dividend_period import parse_date
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

# stock_zh_a_hist 返回中文列名（§6.2 行解析）
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
        codes = list(code_map.keys())

        rp = itf.response_parse or {}
        batch_size = max(1, int(rp.get("max_codes_per_request", 800) or 800))
        resp_date_field = rp.get("resp_date_field")
        code_field = itf.resp_code_field or "code"
        price_field = itf.resp_price_field or "price"

        # 预取当日已存在行，作为同日重抓覆盖 close 的幂等 upsert 基础
        existing = {
            r.master_id: r
            for r in (
                (
                    await self.session.execute(
                        select(MarketSecurityDailyPrice).where(
                            MarketSecurityDailyPrice.trade_date == today
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
                logger.warning("收盘价批次 %d 只整批丢弃", len(batch))
                continue
            # 防线二：返回日期比对（§6.2——返回日期 ≠ 今日即整批跳过，节假日/停牌防污。
            # 同批混有停牌股（返回上一交易日日期）时也必须拦下，故收紧为全等比较）
            if resp_date_field is not None:
                dates = {parse_date(_row_get(r, resp_date_field)) for r in rows}
                dates.discard(None)
                if dates and dates != {today}:
                    logger.warning(
                        "批次返回日期 %s ≠ 今日 %s，整批跳过", sorted(dates), today.isoformat()
                    )
                    failed_batches += 1
                    continue
            batch_written = 0
            for r in rows:
                raw_code = _row_get(r, code_field)
                if raw_code is None:
                    continue
                code = _normalize_master_code(str(raw_code), infer_exchange(str(raw_code)))
                master_id = code_map.get(code)
                if master_id is None:
                    continue  # 未命中 master，跳过该行
                raw_close = _row_get(r, price_field)
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
                        trade_date=today,
                        close=close,
                        source=itf.name,
                        fetched_at=fetched_at,
                    )
                    self.session.add(row)
                    existing[master_id] = row
                else:
                    row.close = close
                    row.source = itf.name
                    row.fetched_at = fetched_at
                changed.add(master_id)
                batch_written += 1
            if batch_written > 0:
                success_batches += 1
                total_rows += batch_written

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
            backfill_note = await self._run_backfill(itf, code_map, backfill_start_raw)

        result = (
            f"收盘价抓取完成：成功批次 {success_batches}，成功行 {total_rows}，"
            f"失败批次 {failed_batches}，重算证券 {len(changed)} 只，"
            f"stale 标记 {stale_count} 行，日期 {today.isoformat()}"
        )
        if backfill_note:
            result += f"；{backfill_note}"
        return result

    async def _run_backfill(
        self, itf: QuoteInterface, code_map: dict[str, str], backfill_start_raw: str
    ) -> str:
        """解析 backfill_start 并执行历史回补（fail fast 抛错由任务层落 FAILED）。"""
        try:
            start = date.fromisoformat(str(backfill_start_raw).strip())
        except ValueError as exc:
            raise RuntimeError(
                f"backfill_start 非法（须 ISO 日期 YYYY-MM-DD）：{backfill_start_raw!r}"
            ) from exc
        if itf.access_method if False else True:
            pass
        provider = await self.session.get(SecuritiesDataProvider, itf.provider_id)
        if provider is None or provider.access_method != QuoteProviderAccessMethod.SDK:
            raise RuntimeError(
                "历史回补要求行情接口 access_method=sdk（stock_zh_a_hist），"
                f"当前接口 {itf.name!r} 的提供方不符"
            )
        master_ids = list(dict.fromkeys(code_map.values()))
        return await backfill_historical(self.session, itf, master_ids, start)


# --------------------------------------------------------------------------- #
# 历史日线回补（§6.2 末段 / 决策 A15）——单独方法供复用，不注册为任务默认调用
# --------------------------------------------------------------------------- #
async def backfill_historical(
    session, itf: QuoteInterface, master_ids: list[str], start_date: date
) -> str:
    """用 akshare ``stock_zh_a_hist`` 回补证券历史日线，按证券独立 commit、断点续跑。

    - ``itf`` 须为配置好的 SDK 行情接口（endpoint=``stock_zh_a_hist``），access_method=sdk；
    - 断点即数据本身：进度 = 该证券在 ``market_security_daily_prices`` 已存在的最早
      ``trade_date``，起点已覆盖 ``start_date`` 的证券跳过（无额外游标表）；
    - burst≈10 只/批 + 批间冷却 60–120s + 指数退避 60/120/300s（决策 A15），每批记进度日志。
    """
    mds = MarketDataSyncService(session)
    today = today_app_tz()
    start_fmt = start_date.strftime("%Y%m%d")
    end_fmt = today.strftime("%Y%m%d")
    total = len(master_ids)
    done = 0
    skipped = 0
    failed = 0
    written = 0

    for start in range(0, total, _BACKFILL_BURST):
        for mid in master_ids[start : start + _BACKFILL_BURST]:
            sec = await session.get(Security, mid)
            if sec is None:
                done += 1
                continue
            # 断点即数据本身（P1-3）：已有最早 trade_date ≤ start_date ⇒ 起点已覆盖，跳过。
            # 勿用 max(trade_date)——若日线任务先跑了近期数据，latest=today ≥ start_date
            # 会把中间历史空洞的证券全部误跳过，空洞永不回填。
            earliest = (
                await session.execute(
                    select(MarketSecurityDailyPrice.trade_date)
                    .where(MarketSecurityDailyPrice.master_id == mid)
                    .order_by(MarketSecurityDailyPrice.trade_date.asc())
                    .limit(1)
                )
            ).scalar_one_or_none()
            if earliest is not None and earliest <= start_date:
                done += 1
                skipped += 1
                continue
            params = {
                # akshare stock_zh_a_hist 的 symbol 须为纯数字代码（如 600519），
                # Security.code 带交易所前缀（sh600519），须剥离（P2-2，对照 notice_scan）。
                "symbol": re.sub(r"\D", "", sec.code),
                "start_date": start_fmt,
                "end_date": end_fmt,
                "adjust": "",
            }
            hist_written = 0
            succeeded = False
            for attempt, wait in enumerate(_BACKFILL_BACKOFFS, start=1):
                try:
                    rows = await mds._fetch_sdk_raw(itf, params, codes=None)
                except Exception as exc:  # noqa: BLE001  退避重试
                    logger.warning(
                        "回补 %s 第 %d/%d 次失败 %s，%ds 后重试",
                        sec.code, attempt, len(_BACKFILL_BACKOFFS), exc, wait,
                    )
                    await asyncio.sleep(wait)
                    continue
                hist_written = await _upsert_hist_rows(session, mid, rows, itf.name)
                await session.commit()
                written += hist_written
                succeeded = True
                break
            if not succeeded:
                failed += 1
                await session.rollback()
            done += 1
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


async def _upsert_hist_rows(session, master_id: str, rows: list[dict], source: str) -> int:
    """把 ``stock_zh_a_hist`` 返回行（``日期``/``收盘`` 中文列）幂等 upsert 进日线表。"""
    if not rows:
        return 0
    trace: dict[date, Decimal] = {}
    for r in rows:
        d = parse_date(r.get(_COL_HIST_DATE))
        if d is None:
            continue
        raw = r.get(_COL_HIST_CLOSE)
        if raw is None:
            continue
        try:
            trace[d] = Decimal(str(raw))
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
# 模块级 handler 入口（供 scheduler 薄注册；独立会话对齐既有 handler 风格）
# --------------------------------------------------------------------------- #
async def run_market_daily_close_fetch(cfg: Any) -> str:
    """每日收盘价抓取 handler。"""
    from app.db.database import AsyncSessionLocal

    async with AsyncSessionLocal() as session:
        result = await MarketDailyPriceSyncService(session).daily_close_fetch(cfg)
    return result