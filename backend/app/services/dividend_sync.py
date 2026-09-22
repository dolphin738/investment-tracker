"""股息率采集服务：五年留存清理 + 全量重建（方案 §6.3/§6.4）。

数据源由配置表 ``dividend_yield_settings``（§6.5）驱动，复用 ``market_data_sync``
既有的 ``_call_interface_raw``/``_upsert_masters``/``_RATE_LIMITER`` 链路（§11.3 复用红线），
**不重写**行情请求/主数据写入。

本模块同时承载两个采集 handler 共享的派生快照重建入口：
``refresh_yields_for_masters``（market_daily_price_sync / dividend_notice_scan 复用）。

- ``dividend_retention_cleanup``：按 ``report_year`` 清理 N 年前记录（N 取配置，默认 5），
  顺带刷新交易日历（决策 A9）。
- ``dividend_yield_rebuild``：全量重建派生快照（默认禁用，admin 手动 trigger）。
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from sqlalchemy import (
    delete as sa_delete,
    select,
)

from app.core.date_utils import today_app_tz
from app.models import (
    DividendYieldSettings,
    MarketSecurityDailyPrice,
    SecurityDividend,
    SecurityDividendYield,
)
from app.models.dividend_yield import DEFAULT_DIVIDEND_RETENTION_YEARS
from app.services.market_data_sync import MarketDataSyncService
from app.services.response_fields import code_candidates_for
from app.services.dividend_period import subtract_years
from app.services.dividend_yield_refresh import (
    refresh_trade_calendar,
    refresh_yields_for_masters,
)

logger = logging.getLogger(__name__)

# 留存窗口（§6.3）：保留最近 N 个财年；N 读配置 ``dividend_retention_years``（D-4 配置化），
# 缺失回落 ``DEFAULT_DIVIDEND_RETENTION_YEARS``（与 DB 列 server_default='5' 一致）。
# 日线留存（§6.3）：曲线只需 1 年，留 1 年余量，保留 2 年
_PRICE_RETENTION_YEARS = 2


def _code_of(itf: Any, row: Any) -> Any:
    """取行内证券代码（与 HEAD ``_code_of`` 逐行等价）。

    候选顺序由 ``code_candidates_for`` 按 ``category_id`` 确定性分派（分红用途 cat=3：
    配置列优先且空值跳过），中文兜底列名不在本模块硬编码（护栏 ⑥）。用 **dict-only**
    ``row.get(field)`` 取值（不解析点号路径、不取数组下标），与 HEAD 语义一致。
    """
    for field in code_candidates_for(itf):
        val = row.get(field) if isinstance(row, dict) else None
        if val is not None:
            return val
    return None


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

    # ------------------------------------------------------------------ #
    # 五年留存清理（§6.3）
    # ------------------------------------------------------------------ #
    async def retention_cleanup(self, cfg: Any) -> str:
        """留存清理：保留最近 ``settings.dividend_retention_years`` 个财年
        （窗口 [cur-years+1, cur]，即真 N 年），删除更早的 report_year（含 PROPOSED/REJECTED）；
        日线按 trade_date 保留 ``_PRICE_RETENTION_YEARS`` 年。

        年数读全局配置 ``dividend_yield_settings.dividend_retention_years``（D-4 配置化，
        owner 定「完整可配」）；未配置（无配置行 / 显式 NULL）时回落
        ``DEFAULT_DIVIDEND_RETENTION_YEARS`` 作默认，避免前端硬编码 ``cur-4`` 漂移。
        """
        today = today_app_tz()
        settings = await self._settings()
        years = (
            settings.dividend_retention_years
            if settings is not None and settings.dividend_retention_years is not None
            else DEFAULT_DIVIDEND_RETENTION_YEARS
        )
        cutoff = today.year - years + 1
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
            f"留存清理完成（留存窗 {years} 年）："
            f"删分红 {res_div.rowcount or 0} 行、日线 {res_price.rowcount or 0} 行，"
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
