"""``market_security_daily_prices`` 全部写入路径（单日横截面 + 历史日线）。

自 ``market_daily_price_sync`` 抽出（《架构治理规范》§4：存量超限文件禁止继续增长）。
职责边界：**只**负责把已抓取的行幂等写入日线表，不做网络请求、不做选批、不读全局配置——

- ``MarketDailyPriceWriteMixin``：``_write_one_day`` / ``_upsert_day_rows`` —— 日抓与缺口
  回补共用的**单日横截面**幂等 upsert（同 ``existing`` 内已有行覆盖 close/source/fetched_at）；
- ``_upsert_hist_rows``：历史日线（akshare ``stock_zh_a_hist``）逐只写入，按接口声明的
  date/price 槽取值、未声明时回退旧中文列，支持 rebuild 的 ``replace_window`` 清空后重建
  （含源响应头部截断防护）；
- ``_COL_HIST_DATE`` / ``_COL_HIST_CLOSE``：旧列兜底常量（仅用于未声明 date/price 槽的
  历史 SDK 接口）。

本模块**不**反向依赖 ``market_daily_price_sync`` / 回补引擎（避免循环导入），边界约定同
``market_price_backfill_gaps``：拆出模块不回指主文件。
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy import delete as sa_delete

from app.core.date_utils import parse_date
from app.models import MarketSecurityDailyPrice, QuoteInterface
from app.services.market_data_sync import _normalize_master_code, infer_exchange
from app.services.response_fields import (
    SLOT_CODE,
    SLOT_DATE,
    SLOT_PRICE,
    index_by_slot,
    resolve_fields,
)
from app.services.response_path import CompiledField

logger = logging.getLogger(__name__)

# 旧列兜底：仅用于**未声明** date/price 槽的历史 SDK 接口（未配置 response_fields 时的
# 旧列合成路径，此时 date 槽为空）。新注册接口应声明 date/price 槽，取值走 resolve_fields；
# 此处中文列名不再写死使用。
_COL_HIST_DATE = "日期"
_COL_HIST_CLOSE = "收盘"


class MarketDailyPriceWriteMixin:
    """单日横截面写入 mixin（``market_security_daily_prices`` 幂等 upsert）。

    以 **mixin** 而非模块级函数 + ``svc`` 形参，是为保证**零调用点改动**：宿主类
    ``MarketDailyPriceSyncService`` 继承本 mixin 后，``self._write_one_day(...)` /
    ``self._upsert_day_rows(...)`` / ``self._last_batch_error_kinds`` 全部按原样工作。

    依赖宿主提供：``self.session``、``self._mds``（``MarketDataSyncService``）、
    ``self._fetch_batch_guarded``、``self._last_batch_error_kinds``。
    """

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

        副作用：本轮**批次异常类名**聚合进 ``self._last_batch_error_kinds``（每次进入重置、
        结束定型），供调用方落 ``app_logs.detail``（D1 只把它打到 stderr、未落库；T1-b 补上）。
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
        # 重置并绑定本轮异常类名聚合（避免上一轮残留）；_fetch_batch_guarded 把类名 add 进来。
        self._last_batch_error_kinds = set()
        error_kinds = self._last_batch_error_kinds

        for start in range(0, len(codes), batch_size):
            batch = codes[start : start + batch_size]
            rows = await self._fetch_batch_guarded(
                itf, itf.params, batch, error_kinds=error_kinds
            )
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
