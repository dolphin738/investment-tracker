"""日线抓取 + 历史回补服务单测（mock 网络层，不触真实 akshare/腾讯）。

守护决策 A9（双防线：交易日历校验主 + 返回日期比对备）/ A15（回补常量）/
附录 A.11（burst≈10 + 冷却 60-120s + 指数退避 60/120/300s）。
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select, text

from app.core.date_utils import today_app_tz
from app.models import (
    DividendYieldSettings,
    GAP_STATUS_PENDING,
    MarketPriceBackfillGap,
    MarketSecurityDailyPrice,
    MarketTradeCalendar,
    QuoteInterface,
    SecuritiesDataProvider,
    Security,
    SecurityDividend,
)
from app.models.enums import DividendStatus, QuoteProviderAccessMethod, ReportPeriodType, SecurityType
from app.models.interface_category import InterfaceCategory
from app.services.market_data_sync import (
    QUOTE_CAT_ID,
    MarketDataSyncService,
    _normalize_master_code,
    infer_exchange,
)
from app.services.market_daily_price_sync import (
    MarketDailyPriceSyncService,
    _acquire_backfill_lease,
    _select_gap_backfill_masters,
    _select_pending_backfill_masters,
    backfill_historical,
    run_pending_price_backfill,
    _BACKFILL_BACKOFFS,
    _BACKFILL_BURST,
    _BACKFILL_COOLDOWN_MAX,
    _BACKFILL_COOLDOWN_MIN,
)



def _uid() -> str:
    return str(uuid.uuid4())


# ───────────────────────── 回补常量（决策 A15 / 附录 A.11） ─────────────────────────

async def _add_master(session, code="600000"):
    norm = _normalize_master_code(code, infer_exchange(code))
    m = Security(id=_uid(), code=norm, name="浦发银行", asset_class=SecurityType.STOCK)
    session.add(m)
    await session.flush()
    return m


# ───────────────────────── 双防线之防线一（决策 A9 主） ─────────────────────────

@pytest.mark.asyncio
async def test_select_gap_backfill_masters_skips_bj(session):
    """守护方案 D：gap 口径下，腾讯源的 BJ 洞（gapped 腿）同样被排除。"""
    bj = Security(id=_uid(), code="830799", name="北交所A", asset_class=SecurityType.STOCK, exchange="BJ")
    sh = Security(id=_uid(), code="600000", name="浦发银行", asset_class=SecurityType.STOCK, exchange="SH")
    session.add_all([bj, sh])
    await session.flush()
    for m in (bj, sh):
        session.add(SecurityDividend(
            master_id=m.id, report_year=2024, report_quarter=1,
            period_type=ReportPeriodType.ANNUAL,
            cash_per_share=Decimal("1.0"), status=DividendStatus.PAID,
        ))
    # 交易日历覆盖窗口两端，使 sync_price_backfill_gaps 返回非 None（不回落 legacy）。
    # 上界取远日期，避免依赖测试机「今日」导致 hi_covered=False。
    session.add(MarketTradeCalendar(trade_date=date(2024, 1, 1)))
    session.add(MarketTradeCalendar(trade_date=date(2026, 9, 12)))
    session.add(MarketTradeCalendar(trade_date=date(2030, 12, 31)))
    # 手动植入 pending 洞（落在窗口内，不会被 sync 的日期范围 DELETE 清掉）
    for m in (bj, sh):
        session.add(MarketPriceBackfillGap(
            master_id=m.id, gap_date=date(2024, 6, 1),
            status=GAP_STATUS_PENDING, attempts=0,
        ))
    await session.commit()

    result, calendar_ok = await _select_gap_backfill_masters(
        session, date(2024, 1, 1), 10, skip_exchange="BJ"
    )
    assert calendar_ok is True
    assert bj.id not in result
    assert sh.id in result
