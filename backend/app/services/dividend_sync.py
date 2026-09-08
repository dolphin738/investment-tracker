"""股息率采集服务：季度抓取 + 五年留存清理 + 全量重建（方案 §6.1/§6.3/§6.4）。

数据源由配置表 ``dividend_yield_settings``（§6.5）驱动，复用 ``market_data_sync``
既有的 ``_call_interface_raw``/``_upsert_masters``/``_RATE_LIMITER`` 链路（§11.3 复用红线），
**不重写**行情请求/主数据写入。

本模块同时承载三个采集 handler 共享的派生快照重建入口：
``refresh_yields_for_masters``（market_daily_price_sync / dividend_notice_scan 复用）。

- ``dividend_quarterly_fetch``：按报告期迭代抓取（缺失补抓 + 最近 4 期重刷），按报告期独立 commit。
- ``dividend_retention_cleanup``：按 ``report_year`` 清理 5 年前记录，顺带刷新交易日历（决策 A9）。
- ``dividend_yield_rebuild``：全量重建派生快照（默认禁用，admin 手动 trigger）。
"""
from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import (
    delete as sa_delete,
    or_,
    select,
)

from app.core.date_utils import parse_date, today_app_tz
from app.models import (
    DividendYieldSettings,
    MarketSecurityDailyPrice,
    QuoteInterface,
    Security,
    SecurityDividend,
    SecurityDividendYield,
)
from app.models.enums import (
    DividendStatus,
    JobTriggerSource,
    ReportPeriodType,
)
from app.services.market_data_sync import (
    DIVIDEND_LIST_CAT_ID,
    MarketDataSyncService,
    _normalize_master_code,
    infer_exchange,
)

from app.services.dividend_period import (
    back_n_quarters,
    last_day,
    parse_cash,
    parse_report_period,
    subtract_years,
)
from app.services.dividend_yield_refresh import (
    refresh_trade_calendar,
    refresh_yields_for_masters,
)

logger = logging.getLogger(__name__)

# 方案进度 → DividendStatus 精确映射（§3.2 五值表；命中 REJECTED 防止计作分子）
_STATUS_MAP = {
    "实施分配": DividendStatus.PAID,
    "预披露": DividendStatus.PROPOSED,
    "董事会决议通过": DividendStatus.PROPOSED,
    "取消分配": DividendStatus.REJECTED,
    "股东大会否决": DividendStatus.REJECTED,
}

# 季度 → 报告期月末日（MM）
_QUARTER_END_MONTH = {1: "0331", 2: "0630", 3: "0930", 4: "1231"}
# 报告期 → period_type（Q4 年报 / Q2 半年报 / 其余季报）
_QUARTER_PERIOD_TYPE = {
    1: ReportPeriodType.QUARTERLY,
    2: ReportPeriodType.INTERIM,
    3: ReportPeriodType.QUARTERLY,
    4: ReportPeriodType.ANNUAL,
}

# 东财分红配送列名（§6.1 映射；缺失列的行跳过）
_COL_REPORT = "报告期"
_COL_CASH = "现金分红-现金分红比例"
_COL_STATUS = "方案进度"
_COL_EX_DATE = "除权除息日"
_COL_RECORD_DATE = "股权登记日"

# 留存窗口（§6.3）：保留最近 5 个财年
_RETENTION_YEARS = 5
# 重刷最近报告期数（§6.1：与 TTM 的 4 个季度格子同宽）
_REFRESH_RECENT_PERIODS = 4
# 日线留存（§6.3）：曲线只需 1 年，留 1 年余量，保留 2 年
_PRICE_RETENTION_YEARS = 2


class DividendSyncService:
    """股息事件采集（复用 market_data_sync 的请求/主数据机制）。"""

    def __init__(self, session) -> None:
        self.session = session
        self._mds = MarketDataSyncService(session)

    # ------------------------------------------------------------------ #
    # 配置读取（§5.4 四重校验：存在性 + 分类归属 + enabled）
    # ------------------------------------------------------------------ #
    async def _settings(self) -> Optional[DividendYieldSettings]:
        return (
            await self.session.execute(select(DividendYieldSettings).limit(1))
        ).scalar_one_or_none()

    async def _resolve_interface(
        self, settings, interface_id: str, category_id: str
    ) -> Optional[QuoteInterface]:
        """解析并校验接口：不存在 / 分类不符 / 未启用 → None（调用方 fail fast 记告警跳过）。"""
        if not interface_id:
            return None
        itf = await self.session.get(QuoteInterface, interface_id)
        if itf is None or itf.category_id != category_id or not itf.enabled:
            return None
        return itf

    # ------------------------------------------------------------------ #
    # 季度抓取（§6.1）
    # ------------------------------------------------------------------ #
    async def quarterly_fetch(self, cfg: Any, *, force: bool = False) -> str:
        """按报告期抓取分红事件：缺失补抓 + 最近 4 期重刷；按报告期独立 commit。

        ``force=True``（手动触发，P1-2）：跳过季末 guard——方案 §7 冷启动要求
        「首次上线手动 trigger 回补 5 年股息」，若 guard 对手动也生效则该路径永不可用。
        """
        today = today_app_tz()
        # 季末 guard（cron 只表达 28-31，真实季末日由任务内判定）；手动触发放行
        if not force and not (
            today.month in (3, 6, 9, 12) and today.day == last_day(today)
        ):
            return f"非季度末日（{today.isoformat()}），跳过本季度股息抓取"

        settings = await self._settings()
        if settings is None:
            raise RuntimeError("股息率配置表为空，无法执行季度抓取")
        itf = await self._resolve_interface(
            settings, settings.dividend_report_source_interface_id, DIVIDEND_LIST_CAT_ID
        )
        if itf is None:
            raise RuntimeError("股息主源接口缺失或被停用，fail fast 跳过本次季度抓取")

        periods = await self._pending_periods(today.year)
        if not periods:
            return "无需要补抓或重刷的报告期"
        summary = []
        changed: set[str] = set()
        for year, quarter in periods:
            try:
                rows = await self._fetch_period(itf, year, quarter)
                mids = await self._upsert_dividend_batch(itf, rows, year, quarter)
                await self.session.commit()
                changed.update(mids)
                summary.append(f"{year}Q{quarter}({len(rows)})")
            except Exception as exc:  # 单报告期失败续下一期（断点即数据本身）
                await self.session.rollback()
                summary.append(f"{year}Q{quarter}失败:{exc}")

        await refresh_yields_for_masters(self.session, list(changed))
        await self.session.commit()
        return f"季度抓取完成；报告期:{';'.join(summary) or '无'};重算证券{len(changed)}只"

    async def _pending_periods(self, cur_year: int) -> list[tuple[int, int]]:
        """待抓报告期 = 缺失集合（近 5 年网格内）∪ 最近 4 期（§6.1）。"""
        existing = set(
            (
                await self.session.execute(
                    select(SecurityDividend.report_year, SecurityDividend.report_quarter)
                    .where(SecurityDividend.period_type != ReportPeriodType.SPECIAL)
                    .distinct()
                )
            ).all()
        )
        grid = [(y, q) for y in range(cur_year - 4, cur_year + 1) for q in range(1, 5)]
        missing = [(y, q) for y, q in grid if (y, q) not in existing]
        latest = max(existing, default=grid[-1])
        recent = [back_n_quarters(*latest, n) for n in range(_REFRESH_RECENT_PERIODS)]
        out: list[tuple[int, int]] = []
        seen: set[tuple[int, int]] = set()
        for p in missing + recent:
            if p not in seen:
                seen.add(p)
                out.append(p)
        return out

    async def _fetch_period(self, itf: QuoteInterface, year: int, quarter: int) -> list[dict]:
        """调用东财按报告期抓取（SDK 全量形态，覆写 params.date）。"""
        params = {**(itf.params or {}), "date": f"{year}" + _QUARTER_END_MONTH[quarter]}
        return await self._mds._call_interface_raw(itf, params, codes=None)

    async def _upsert_dividend_batch(
        self, itf: QuoteInterface, rows: list[dict], year: int, quarter: int
    ) -> list[str]:
        """主数据 upsert + 分红事件 upsert；返回有变更的 master_id 集合。

        东向去重（§6.1）：写入前删除同 master 下「ex_date 相等」或
        「(year, quarter, cash) 全等」的 SPECIAL 行（报告期行归属更准，胜出）。
        """
        if not rows:
            return []
        await self._mds._upsert_masters(itf, rows)
        # 建 code → master_id 映射（Security.code 已带交易所前缀）
        codes = set()
        for r in rows:
            raw = r.get(itf.resp_code_field or "代码")
            if raw is None:
                continue
            codes.add(_normalize_master_code(str(raw), infer_exchange(str(raw))))
        code_maps = {}
        if codes:
            sec_rows = (
                await self.session.execute(select(Security).where(Security.code.in_(codes)))
            ).scalars().all()
            code_maps = {s.code: s.id for s in sec_rows}
        changed: list[str] = []
        seen_cells: set[tuple[str, int, int, ReportPeriodType]] = set()  # P2-2 同格多行告警
        for r in rows:
            code_raw = r.get(itf.resp_code_field or "代码")
            if code_raw is None:
                continue
            code = _normalize_master_code(str(code_raw), infer_exchange(str(code_raw)))
            master_id = code_maps.get(code)
            if master_id is None:
                continue
            rperiod = parse_report_period(r.get(_COL_REPORT)) or (year, quarter)
            ry, rq = rperiod
            cash = parse_cash(r.get(_COL_CASH))
            if cash is None:
                continue
            status_txt = str(r.get(_COL_STATUS)).strip() if r.get(_COL_STATUS) is not None else ""
            status = _STATUS_MAP.get(status_txt)
            if status is None:
                logger.warning(
                    "东财未识别「方案进度」取值 %r（报告期 %sQ%s），按 §3.2 跳过不落库",
                    status_txt, ry, rq,
                )
                continue
            ex_date = parse_date(r.get(_COL_EX_DATE))
            rec_date = parse_date(r.get(_COL_RECORD_DATE))
            await self._eastward_dedup(master_id, ex_date, ry, rq, cash)
            ptype = _QUARTER_PERIOD_TYPE[rq]
            # P2-2（§12）：同格多行不得静默覆盖——告警后保留末行（与既有 upsert 语义一致）
            cell = (master_id, ry, rq, ptype)
            if cell in seen_cells:
                logger.warning(
                    "同格多行：%s %sQ%s 出现多条源行，保留末行覆盖（§12 告警）",
                    master_id, ry, rq,
                )
            seen_cells.add(cell)
            existing = (
                await self.session.execute(
                    select(SecurityDividend).where(
                        SecurityDividend.master_id == master_id,
                        SecurityDividend.report_year == ry,
                        SecurityDividend.report_quarter == rq,
                        SecurityDividend.period_type == ptype,
                    )
                )
            ).scalar_one_or_none()
            if existing is not None:
                existing.cash_per_share = cash
                existing.status = status
                existing.ex_dividend_date = ex_date
                existing.record_date = rec_date
                existing.source = itf.name
            else:
                self.session.add(
                    SecurityDividend(
                        master_id=master_id,
                        report_year=ry,
                        report_quarter=rq,
                        period_type=ptype,
                        cash_per_share=cash,
                        status=status,
                        ex_dividend_date=ex_date,
                        record_date=rec_date,
                        source=itf.name,
                    )
                )
            changed.append(master_id)
        await self.session.flush()
        return changed

    async def _eastward_dedup(
        self, master_id: str, ex_date, year: int, quarter: int, cash: Decimal
    ) -> None:
        """东向去重（§6.1，P2-1 修 OR 语义）：报告期行上岗前删除同 master 的匹配 SPECIAL 行。

        匹配为 OR 语义：``ex_dividend_date == ex_date``（若已知）**或**
        ``(report_year, report_quarter, cash_per_share)`` 全等——两查并查。
        旧实现二选一：SPECIAL 行 ex_date 不同但三元组全等时会漏删（预案窗口双计）。
        """
        conds = []
        if ex_date is not None:
            conds.append(SecurityDividend.ex_dividend_date == ex_date)
        conds.append(
            (SecurityDividend.report_year == year)
            & (SecurityDividend.report_quarter == quarter)
            & (SecurityDividend.cash_per_share == cash)
        )
        await self.session.execute(
            sa_delete(SecurityDividend).where(
                SecurityDividend.master_id == master_id,
                SecurityDividend.period_type == ReportPeriodType.SPECIAL,
                or_(*conds),
            )
        )

    # ------------------------------------------------------------------ #
    # 五年留存清理（§6.3）
    # ------------------------------------------------------------------ #
    async def retention_cleanup(self, cfg: Any) -> str:
        """留存清理：保留最近 _RETENTION_YEARS 个财年（窗口 [cur-_RETENTION_YEARS+1, cur]，
        即真 5 年），删除更早的 report_year（含 PROPOSED/REJECTED）；
        日线按 trade_date 保留 _PRICE_RETENTION_YEARS 年。"""
        today = today_app_tz()
        cutoff = today.year - _RETENTION_YEARS + 1
        doomed_masters = set(
            (
                await self.session.execute(
                    select(SecurityDividend.master_id)
                    .where(SecurityDividend.report_year < cutoff)
                    .distinct()
                )
            ).scalars().all()
        )
        res_div = await self.session.execute(
            sa_delete(SecurityDividend).where(SecurityDividend.report_year < cutoff)
        )
        price_cutoff = subtract_years(today, _PRICE_RETENTION_YEARS)
        res_price = await self.session.execute(
            sa_delete(MarketSecurityDailyPrice).where(
                MarketSecurityDailyPrice.trade_date < price_cutoff
            )
        )
        await self.session.commit()
        # 顺带刷新交易日历（失败仅记告警不阻断，决策 A9）
        await refresh_trade_calendar(self.session)
        await self.session.commit()
        # 清理后重算受影响证券派生快照（窗口回缩后口径不缺失，§6.3）
        await refresh_yields_for_masters(self.session, list(doomed_masters))
        await self.session.commit()
        return (
            f"五年留存清理完成：删分红 {res_div.rowcount or 0} 行、日线 {res_price.rowcount or 0} 行，"
            f"重算 {len(doomed_masters)} 只"
        )

    # ------------------------------------------------------------------ #
    # 全量重建（§6.4，默认禁用）
    # ------------------------------------------------------------------ #
    async def yield_rebuild(self, cfg: Any) -> str:
        """逐证券从源数据重建派生快照（§6.4 手动 trigger）。

        枚举范围 = 原始分红(SecurityDividend) ∪ 日线价格(MarketSecurityDailyPrice)
        ∪ 既有快照(SecurityDividendYield)。前两者为空（原始数据未采集）但仍有历史
        快照时仍覆盖这些证券，避免「0 只」且防止 refresh 把有值快照改写为 None
        （refresh_yields_for_masters 内部对无源数据者保留而非覆写为空）。
        """
        all_mids = set(
            (await self.session.execute(select(SecurityDividend.master_id).distinct())).scalars().all()
        )
        price_mids = set(
            (
                await self.session.execute(select(MarketSecurityDailyPrice.master_id).distinct())
            ).scalars().all()
        )
        snap_mids = set(
            (
                await self.session.execute(select(SecurityDividendYield.master_id).distinct())
            ).scalars().all()
        )
        mids = all_mids | price_mids | snap_mids
        rebuilt, preserved = await refresh_yields_for_masters(self.session, list(mids))
        await self.session.commit()
        return (
            f"股息率全量重建完成：重算 {rebuilt} 只、保留 {preserved} 只"
            f"（共 {len(mids)} 只证券派生快照）"
        )


# --------------------------------------------------------------------------- #
# 模块级 handler 入口（供 scheduler.py 薄注册；各自开独立会话对齐既有 handler 风格）
# --------------------------------------------------------------------------- #
async def run_dividend_quarterly_fetch(cfg: Any, source: JobTriggerSource | None = None) -> str:
    """季度股息抓取 handler。``source=MANUAL``（手动 trigger）跳过季末 guard（P1-2）。"""
    from app.db.database import AsyncSessionLocal

    async with AsyncSessionLocal() as session:
        result = await DividendSyncService(session).quarterly_fetch(
            cfg, force=source == JobTriggerSource.MANUAL
        )
        await session.commit()
    return result


async def run_dividend_retention_cleanup(cfg: Any) -> str:
    """五年留存清理 handler。"""
    from app.db.database import AsyncSessionLocal

    async with AsyncSessionLocal() as session:
        result = await DividendSyncService(session).retention_cleanup(cfg)
    return result


async def run_dividend_yield_rebuild(cfg: Any) -> str:
    """全量重建 handler。"""
    from app.db.database import AsyncSessionLocal

    async with AsyncSessionLocal() as session:
        result = await DividendSyncService(session).yield_rebuild(cfg)
    return result
