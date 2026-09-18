"""每日收盘价采集服务 + 调度 handler（方案 §6.2）。

- ``market_daily_close_fetch``：每交易日 15:05 抓取选定「证券行情」（分类 2）接口当天收盘价，
  幂等 upsert 到 ``market_security_daily_prices``。复用 ``market_data_sync`` 既有
  ``_call_interface_raw`` / ``_row_get`` / ``_normalize_master_code`` / 告警链路，不重写请求。
  双防线防节假日/停牌污（决策 A9）：交易日历校验（主）+ 返回日期比对（备）。

写入由 ``market_daily_price_writer`` 的 ``MarketDailyPriceWriteMixin`` 提供（本服务继承）。

组装 handler ``run_market_daily_close_fetch`` 供 scheduler 注册（独立会话）。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from sqlalchemy import select

from app.core.date_utils import today_app_tz
from app.db.database import AsyncSessionLocal
from app.models import (
    DividendYieldSettings,
    QuoteInterface,
    Security,
    SecurityDividend,
)
from app.services.dividend_yield_refresh import (
    is_trade_day,
    refresh_yields_for_masters,
    update_stale_flags,
)
from app.services.log import record as record_app_log
from app.services.market_data_sync import (
    QUOTE_CAT_ID,
    MarketDataSyncService,
)
from app.services.market_daily_price_writer import MarketDailyPriceWriteMixin

# 每日收盘价「批次请求异常」重试前的退避（秒）。内层 _guarded_fetch 已按接口 retry_count
# 做过指数退避；外层这次「再来一次」若紧接 continue 会**立即**重打源站——源站已不堪时
# 会加剧雪崩、并很可能触发风控封禁。故重试前先退避，给源站一个喘息窗口；取常量便于测试
# 置 0。注意：单批次的最坏请求次数 = 外层 2 次 × 内层 (1 + retry_count) 次。
_BATCH_RETRY_BACKOFF_SECONDS = 2.0

logger = logging.getLogger(__name__)


class MarketDailyPriceSyncService(MarketDailyPriceWriteMixin):
    """每日收盘价采集（复用 market_data_sync 请求/主数据机制）。

    继承 ``MarketDailyPriceWriteMixin``：单日横截面写入（``_write_one_day`` /
    ``_upsert_day_rows``）由 mixin 提供，``self._write_one_day(...)`` 等调用点零改动。
    """

    def __init__(self, session) -> None:
        self.session = session
        self._mds = MarketDataSyncService(session)
        # 最近一次 _write_one_day 的批次异常类名聚合（T1-b 诊断用）；生命周期 = 单次
        # _write_one_day（开头重置、结束定型），供 daily_close_fetch 落 app_logs.detail。
        self._last_batch_error_kinds: set[str] = set()

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
        self,
        itf: QuoteInterface,
        params,
        codes: list[str],
        *,
        error_kinds: "set[str] | None" = None,
    ) -> Optional[list]:
        """批次拉取 + 返回行数校验（缺数重试一次；整体为 0 则整批丢弃返回 None）。

        异常日志同时打印**异常类名 + 消息**：httpx 的超时类异常（ConnectTimeout /
        ReadTimeout 等）``str(exc) == ""``，只打消息会让日志沦为「异常 ，重试」这种完全
        不可诊断的空壳（本次故障现场即如此）；类名可区分超时 / 连接失败 / 5xx。

        Args:
            error_kinds: 可选关键字参数，**默认 None → 行为完全不变**（不破坏既有调用/测试
                签名）。非 None 时把每次捕获到的异常类名 ``add`` 进去（调用方创建并持有一轮
                的 set），用于把「本轮异常类型」从只打 stderr 带出到结构化落库（T1-b）。
        """
        for attempt in (0, 1):
            try:
                rows = await self._mds._call_interface_raw(itf, params, codes=codes)
            except Exception as exc:  # noqa: BLE001  请求异常走重试
                if error_kinds is not None:
                    # 聚合本轮异常类名（set 去重）：两轮请求可能是不同异常（如先 ConnectTimeout
                    # 后 ConnectError），都记下更利于诊断；重复类型自动收敛。
                    error_kinds.add(type(exc).__name__)
                logger.warning(
                    "收盘价批次 %d 只请求异常 %s: %s，重试",
                    len(codes),
                    type(exc).__name__,
                    exc,
                )
                if attempt == 0:
                    # 重试前退避：详见 _BATCH_RETRY_BACKOFF_SECONDS（避免源站已不堪时立即重打）
                    await asyncio.sleep(_BATCH_RETRY_BACKOFF_SECONDS)
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
        """抓取当天收盘价并 upsert；防线失败 / 无效源 / **零写入**时抛错、非交易日返回跳过信息。

        返回值：正常（含**部分失败**）时返回含计数与日期的摘要串，调度器据其记 SUCCESS。

        抛错（调度器据此记 FAILED）：① 配置表为空；② 行情源接口缺失 / 停用；③ 走过早期守卫
        （非交易日 / 无证券）并拿到非空 ``code_map`` 后 ``total_rows == 0``（整轮零行写入）。
        ③ 覆盖用户要求的「成功批次 0 且失败批次 > 0」，并额外覆盖「成功 0 / 失败 0 但零写入」
        （``batch_written == 0`` 时既不计 success 也不计 failed）。

        「零写入即失败」安全：``_upsert_day_rows`` 对**已存在的同日行也算写入**（覆盖 close），
        故「有证券池 + 零写入」只可能出自数据 / 源侧问题，不可能是幂等重跑的正常结果。抛错与
        既有契约一致（防线失败 / 无效源即抛）。非交易日 / 无证券早退、以及**部分失败**
        （``total_rows > 0``）仍返回 SUCCESS + 计数串（另由 T1-b 落一条 warning 级 app_logs）。
        """
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
        # 快照接口名：尾部落 app_logs.detail 时 session 可能已过期（提交 / 回滚），
        # 届时同步属性访问会触发惰性加载（异步会话下 MissingGreenlet）。此处读到即存，零风险。
        itf_name = itf.name

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

        result = (
            f"收盘价抓取完成：成功批次 {success_batches}，成功行 {total_rows}，"
            f"失败批次 {failed_batches}，重算证券 {len(changed)} 只，"
            f"stale 标记 {stale_count} 行，日期 {today.isoformat()}"
        )

        # —— T1-b：失败批次聚合落 app_logs（每轮最多 1 条，绝不逐批刷）——
        # 触发：有失败批次，或零写入（含「批次解析成功却一行未落库」的组合，靠 total_rows==0
        # 兜住）。时机必须在 commit 之后：record() 用独立会话提交，与仍持行锁的主事务交叉可能
        # 互等。级别：零写入 = 无产出 → error；部分失败（仍有写入）→ warning。
        if failed_batches > 0 or total_rows == 0:
            await record_app_log(
                "error" if total_rows == 0 else "warning",
                "system",
                "market_daily_price_sync",
                result,
                detail={
                    "date": today.isoformat(),
                    "success_batches": success_batches,
                    "failed_batches": failed_batches,
                    "total_rows": total_rows,
                    "codes_total": len(code_map),
                    "interface": itf_name,
                    "error_kinds": sorted(self._last_batch_error_kinds),
                },
            )

        # —— T2：零写入判失败 ——
        # 先落 error 日志（上面）再抛错：调度器把异常落 JobRunLog.error 并记 FAILED，
        # 运维在任务列表上即可看到「失败」而非被 message 计数掩盖的「成功」。
        if total_rows == 0:
            kinds = ",".join(sorted(self._last_batch_error_kinds))
            raise RuntimeError(
                f"{result}；本批 {len(code_map)} 只证券无任何数据写入，任务判失败"
                + (f"（异常类型 {kinds}）" if kinds else "")
            )

        return result

# --------------------------------------------------------------------------- #
# 模块级 handler 入口（供 scheduler 薄注册；独立会话对齐既有 handler 风格）
# --------------------------------------------------------------------------- #
async def run_market_daily_close_fetch(cfg: Any) -> str:
    """每日收盘价抓取 handler。"""
    async with AsyncSessionLocal() as session:
        result = await MarketDailyPriceSyncService(session).daily_close_fetch(cfg)
    return result
