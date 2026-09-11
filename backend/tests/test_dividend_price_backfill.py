"""行情缺口回补测试（``gap_backfill_daily`` / ``POST /api/dividend-yield/backfill-prices``）。

守护 review-unpushed-2026-09-12 M-1：该提交引入 165 行服务方法 + 一个 admin 端点 +
前端按钮却**零测试**，而它写的是 ``market_security_daily_prices``（历史价格表），
是股息率曲线与排名的输入源——出错属**数据污染**而非单纯功能失效，故补齐护栏。

覆盖（按价值排序）：
1. 无配置 / 非 HTTPS 源 / 无日期槽 → fail fast（拒绝把不可信数据写进历史）；
2. 无证券、无缺口 → 早退文案；
3. ``expect_date=False`` 语义：返回日期 ≠ 目标日仍写入（日抓会拒，回补必须放行）；
4. 单日失败不影响其余日期（``asyncio.gather`` 内异常被按日吞掉并汇总）。
"""
from __future__ import annotations

import types
import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
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
from app.models.enums import (
    DividendStatus,
    QuoteProviderAccessMethod,
    ReportPeriodType,
    SecurityType,
)
from app.models.interface_category import InterfaceCategory
from app.services.market_data_sync import (
    QUOTE_CAT_ID,
    _normalize_master_code,
    infer_exchange,
)
from app.services.market_daily_price_sync import MarketDailyPriceSyncService


def _uid() -> str:
    return str(uuid.uuid4())


def _cfg(days: int = 30) -> types.SimpleNamespace:
    """轻量 cfg 壳：handler 只读 ``params``（与 router 的 ``_Cfg`` 同形）。"""
    return types.SimpleNamespace(params={"lookback_days": days})


async def _add_master(session, code: str = "600000") -> Security:
    norm = _normalize_master_code(code, infer_exchange(code))
    m = Security(id=_uid(), code=norm, name="浦发银行", asset_class=SecurityType.STOCK)
    session.add(m)
    await session.flush()
    return m


async def _add_dividend(session, master_id: str) -> None:
    session.add(
        SecurityDividend(
            master_id=master_id, report_year=2024, report_quarter=1,
            period_type=ReportPeriodType.ANNUAL,
            cash_per_share=Decimal("1.0"), status=DividendStatus.PAID,
        )
    )
    await session.flush()


async def _seed_source(
    session,
    access_method: QuoteProviderAccessMethod,
    *,
    with_date: bool = True,
) -> QuoteInterface:
    """造行情源 + 股息率配置表；``with_date=False`` 用于验证「无日期槽」拒绝。"""
    provider = SecuritiesDataProvider(
        id=_uid(), name="src", access_method=access_method,
        config={"base_url": "https://qt.gtimg.cn"}, enabled=True,
    )
    rp: dict = {"max_codes_per_request": 800}
    if with_date:
        rp["resp_date_field"] = "日期"  # 旧列 → resolve_fields 合成 date 槽
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID, name="src",
        endpoint="/q", http_method="GET", enabled=True, priority=1,
        resp_code_field="代码", resp_price_field="收盘",
        response_parse=rp, params={},
    )
    session.add(provider)
    await session.flush()
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    session.add(itf)
    await session.flush()
    session.add(
        DividendYieldSettings(
            green_threshold=Decimal("0.05"), red_threshold=Decimal("0.03"),
            price_source_interface_id=itf.id,
        )
    )
    await session.commit()
    return itf


# ───────────────────────── fail fast 三连（拒绝不可信数据进历史） ─────────────────────────
@pytest.mark.asyncio
async def test_gap_backfill_fails_fast_without_settings(session):
    """配置表为空 → fail fast（无行情源可解析，不得静默跳过）。"""
    svc = MarketDailyPriceSyncService(session)
    with pytest.raises(RuntimeError, match="股息率配置表为空"):
        await svc.gap_backfill_daily(_cfg())


@pytest.mark.asyncio
async def test_gap_backfill_requires_https_access_method(session):
    """缺口回补是「按交易日横截面批量」，要求 access_method=https；SDK 源须拒绝。"""
    await _seed_source(session, QuoteProviderAccessMethod.SDK)
    svc = MarketDailyPriceSyncService(session)
    with pytest.raises(RuntimeError, match="access_method=https"):
        await svc.gap_backfill_daily(_cfg())


@pytest.mark.asyncio
async def test_gap_backfill_requires_date_slot(session):
    """接口未配日期槽 → 拒绝回补：否则无法识别响应时效，会把陈旧价写进历史日期。

    这是本链路**最关键的自愈护栏**（``market_daily_price_sync.py:444-448``）：
    腾讯 ``q=`` 只返回当前价，若日期槽缺失，某历史日的回补就会静默写入「今天的价」。
    """
    # response_parse 刻意不带 resp_date_field、response_fields 为 NULL → 无 date 槽
    await _seed_source(session, QuoteProviderAccessMethod.HTTPS, with_date=False)
    svc = MarketDailyPriceSyncService(session)
    with pytest.raises(RuntimeError, match="未配置日期槽"):
        await svc.gap_backfill_daily(_cfg())


# ───────────────────────── 早退分支 ─────────────────────────
@pytest.mark.asyncio
async def test_gap_backfill_no_securities_returns_early(session):
    """``security_dividends`` 无证券 → 代码池为空，早退且不发任何请求。"""
    await _seed_source(session, QuoteProviderAccessMethod.HTTPS)
    svc = MarketDailyPriceSyncService(session)
    result = await svc.gap_backfill_daily(_cfg())
    assert "security_dividends 无证券" in result


@pytest.mark.asyncio
async def test_gap_backfill_no_gaps_returns_early(session, monkeypatch):
    """已存档日期覆盖完整 → 早退，不发无效请求（不浪费限速配额）。"""
    await _seed_source(session, QuoteProviderAccessMethod.HTTPS)
    m = await _add_master(session)
    await _add_dividend(session, m.id)
    await session.commit()

    async def _no_gaps(self, lookback_days: int) -> list:
        return []

    monkeypatch.setattr(MarketDailyPriceSyncService, "_gap_dates", _no_gaps)
    svc = MarketDailyPriceSyncService(session)
    result = await svc.gap_backfill_daily(_cfg())
    assert "无缺口" in result
    rows = (await session.execute(select(MarketSecurityDailyPrice))).scalars().all()
    assert rows == []  # 早退不写任何行


# ───────────────────────── 核心语义：expect_date=False ─────────────────────────
@pytest.mark.asyncio
async def test_gap_backfill_writes_even_when_returned_date_differs(session, monkeypatch):
    """缺口回补的日期校验被**刻意放宽**（``expect_date=False``），这是它与日抓的唯一差异。

    腾讯 ``q=`` 请求不带日期、只返回当前价，故「回补 3 天前」时返回的日期字段必然是
    **今天**，与待补的 ``target`` 必不相等。若沿用日抓的全等比较，回补会每批被拦、
    永不生效。本测试锁定该语义：**日期不等也须写入，且落在 ``target`` 上**。
    """
    target = today_app_tz() - timedelta(days=3)
    await _seed_source(session, QuoteProviderAccessMethod.HTTPS)
    m = await _add_master(session)
    await _add_dividend(session, m.id)
    await session.commit()

    async def _gap_only_target(self, lookback_days: int) -> list:
        return [target]

    monkeypatch.setattr(MarketDailyPriceSyncService, "_gap_dates", _gap_only_target)

    svc = MarketDailyPriceSyncService(session)

    async def _fake_raw(itf_obj, params, codes):
        # 日期字段是「今天」，与 target 不等（真实腾讯口的形态）
        return [{"代码": "600000", "收盘": "12.34", "日期": today_app_tz().isoformat()}]

    svc._mds._call_interface_raw = _fake_raw
    result = await svc.gap_backfill_daily(_cfg())

    rows = (await session.execute(select(MarketSecurityDailyPrice))).scalars().all()
    assert len(rows) == 1
    assert rows[0].trade_date == target        # 落在待补的目标日，而非今天
    assert rows[0].close == Decimal("12.34")
    assert "写入 1 行" in result


# ───────────────────────── 单日失败隔离 ─────────────────────────
@pytest.mark.asyncio
async def test_gap_backfill_isolates_single_day_failure(session, monkeypatch):
    """某一交易日整体失败（上游 502）→ 仅该日记 fail，其余日期照常写成功。

    守护 ``_one_day`` 的异常吞噬：若这里冒泡，一次网络抖动会终止整轮回补。
    """
    d_ok = today_app_tz() - timedelta(days=2)
    d_bad = today_app_tz() - timedelta(days=1)
    await _seed_source(session, QuoteProviderAccessMethod.HTTPS)
    m = await _add_master(session)
    await _add_dividend(session, m.id)
    await session.commit()

    async def _two_days(self, lookback_days: int) -> list:
        return [d_ok, d_bad]

    monkeypatch.setattr(MarketDailyPriceSyncService, "_gap_dates", _two_days)

    svc = MarketDailyPriceSyncService(session)

    async def _fake_write_day(itf_obj, code_map, target, *, expect_date):
        if target == d_bad:
            raise RuntimeError("上游 502")
        return set(), 1, 0, 1  # (changed, 成功批次, 失败批次, 写入行数)

    svc._write_one_day = _fake_write_day
    result = await svc.gap_backfill_daily(_cfg())

    assert "成功 1" in result
    assert "失败 1" in result  # 坏日子被单独计数，未终止整轮


# ───────────────────────── 入参钳制（防误配一次拉爆） ─────────────────────────
@pytest.mark.asyncio
async def test_gap_backfill_clamps_lookback_days(session, monkeypatch):
    """``lookback_days`` 超上限须被钳到 ``_GAP_MAX_DAYS``（400），不得透传上游。

    路由层与 service 层各钳一次（纵深防御）；本用例守护 service 层那一道。
    """
    await _seed_source(session, QuoteProviderAccessMethod.HTTPS)
    m = await _add_master(session)
    await _add_dividend(session, m.id)
    await session.commit()

    captured: dict = {}

    async def _capture(self, lookback_days: int) -> list:
        captured["lookback"] = lookback_days
        return []

    monkeypatch.setattr(MarketDailyPriceSyncService, "_gap_dates", _capture)
    svc = MarketDailyPriceSyncService(session)
    await svc.gap_backfill_daily(_cfg(days=99999))

    assert captured["lookback"] == 400  # _GAP_MAX_DAYS
