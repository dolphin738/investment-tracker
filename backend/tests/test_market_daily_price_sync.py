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
from sqlalchemy import select

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
def test_backfill_rate_constants():
    """守护附录 A.11 / 决策 A15：burst≈10、冷却 60-120s、退避 60/120/300s。"""
    assert _BACKFILL_BURST == 10
    assert _BACKFILL_COOLDOWN_MIN <= _BACKFILL_COOLDOWN_MAX
    assert _BACKFILL_COOLDOWN_MIN == 60.0
    assert _BACKFILL_COOLDOWN_MAX == 120.0
    assert _BACKFILL_BACKOFFS == (60, 120, 300)  # 指数退避，用尽即放弃该证券


async def _add_master(session, code="600000"):
    norm = _normalize_master_code(code, infer_exchange(code))
    m = Security(id=_uid(), code=norm, name="浦发银行", asset_class=SecurityType.STOCK)
    session.add(m)
    await session.flush()
    return m


# ───────────────────────── 双防线之防线一（决策 A9 主） ─────────────────────────
@pytest.mark.asyncio
async def test_daily_close_fetch_non_trade_day_skips(session):
    """守护决策 A9：非交易日历有值且不含今日 → 整批跳过不抓取。"""
    session.add(MarketTradeCalendar(trade_date=date(2020, 1, 1)))  # 日历非空但非今日
    await session.commit()
    svc = MarketDailyPriceSyncService(session)
    result = await svc.daily_close_fetch({})
    assert "非交易日" in result


# ───────────────────────── 双防线之防线二（决策 A9 备） ─────────────────────────
@pytest.mark.asyncio
async def test_daily_close_fetch_return_date_mismatch_skips_batch(session, monkeypatch):
    """守护决策 A9 / §6.2：返回日期 ≠ 今日 → 整批跳过不写入（节假日/停牌防污）。"""
    today = today_app_tz()
    session.add(MarketTradeCalendar(trade_date=today))  # 防线一通过
    m = await _add_master(session)
    session.add(
        SecurityDividend(master_id=m.id, report_year=today.year, report_quarter=1,
                         period_type=ReportPeriodType.ANNUAL,
                         cash_per_share=Decimal("1.0"), status=DividendStatus.PAID)
    )
    provider = SecuritiesDataProvider(
        id=_uid(), name="腾讯", access_method=QuoteProviderAccessMethod.HTTPS,
        config={"base_url": "https://qt.gtimg.cn"}, enabled=True,
    )
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID, name="腾讯",
        endpoint="/q", http_method="GET", enabled=True, priority=1,
        resp_code_field="代码", resp_price_field="收盘",
        response_parse={"resp_date_field": "日期", "max_codes_per_request": 800},
        params={},
    )
    session.add(provider)
    await session.flush()  # 提供方先落库，接口 provider_id 外键才有归属
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    session.add(itf)
    await session.flush()
    session.add(DividendYieldSettings(green_threshold=Decimal("0.05"),
                                      red_threshold=Decimal("0.03"),
                                      price_source_interface_id=itf.id))
    await session.commit()

    svc = MarketDailyPriceSyncService(session)

    async def _fake_raw(itf_obj, params, codes):
        return [{"代码": "600000", "收盘": "10.5", "日期": "2020-01-01"}]  # 上一交易日

    svc._mds._call_interface_raw = _fake_raw
    result = await svc.daily_close_fetch({})

    # 该批次被整批丢弃，未写入任何日线行
    rows = (await session.execute(select(MarketSecurityDailyPrice))).scalars().all()
    assert rows == []
    assert "失败批次 1" in result
    assert "成功行 0" in result


@pytest.mark.asyncio
async def test_daily_close_fetch_writes_on_matching_date(session):
    """守护 §6.2：返回日期 == 今日 → 幂等写入当日收盘价并重算派生快照。"""
    today = today_app_tz()
    session.add(MarketTradeCalendar(trade_date=today))
    m = await _add_master(session)
    session.add(
        SecurityDividend(master_id=m.id, report_year=today.year, report_quarter=4,
                         period_type=ReportPeriodType.ANNUAL,
                         cash_per_share=Decimal("1.0"), status=DividendStatus.PAID)
    )
    provider = SecuritiesDataProvider(
        id=_uid(), name="腾讯", access_method=QuoteProviderAccessMethod.HTTPS,
        config={"base_url": "https://qt.gtimg.cn"}, enabled=True,
    )
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID, name="腾讯",
        endpoint="/q", http_method="GET", enabled=True, priority=1,
        resp_code_field="代码", resp_price_field="收盘",
        response_parse={"resp_date_field": "日期", "max_codes_per_request": 800},
        params={},
    )
    session.add(provider)
    await session.flush()  # 提供方先落库，接口 provider_id 外键才有归属
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    session.add(itf)
    await session.flush()
    session.add(DividendYieldSettings(green_threshold=Decimal("0.05"),
                                      red_threshold=Decimal("0.03"),
                                      price_source_interface_id=itf.id))
    await session.commit()

    svc = MarketDailyPriceSyncService(session)

    async def _fake_raw(itf_obj, params, codes):
        return [{"代码": "600000", "收盘": "12.34", "日期": today.strftime("%Y-%m-%d")}]

    svc._mds._call_interface_raw = _fake_raw
    result = await svc.daily_close_fetch({})

    rows = (await session.execute(select(MarketSecurityDailyPrice))).scalars().all()
    assert len(rows) == 1
    assert rows[0].trade_date == today
    assert rows[0].close == Decimal("12.34")
    assert "成功行 1" in result

@pytest.mark.asyncio
async def test_daily_close_fetch_mixed_dates_batch_rejected(session, monkeypatch):
    """守护 P2-2（§6.2）：批次混有停牌股（返回上一交易日日期）→ 整批跳过。

    旧实现「today in dates（任一命中即放行）」拦不住停牌脏价；收紧为 dates != {today} 后，
    本测试构成真回归守护。
    """
    today = today_app_tz()
    session.add(MarketTradeCalendar(trade_date=today))
    m1 = await _add_master(session, code="600001")
    m2 = await _add_master(session, code="600002")
    for m in (m1, m2):
        session.add(
            SecurityDividend(master_id=m.id, report_year=today.year, report_quarter=1,
                             period_type=ReportPeriodType.ANNUAL,
                             cash_per_share=Decimal("1.0"), status=DividendStatus.PAID)
        )
    provider = SecuritiesDataProvider(
        id=_uid(), name="腾讯", access_method=QuoteProviderAccessMethod.HTTPS,
        config={"base_url": "https://qt.gtimg.cn"}, enabled=True,
    )
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID, name="腾讯",
        endpoint="/q", http_method="GET", enabled=True, priority=1,
        resp_code_field="代码", resp_price_field="收盘",
        response_parse={"resp_date_field": "日期", "max_codes_per_request": 800},
        params={},
    )
    session.add(provider)
    await session.flush()
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    session.add(itf)
    await session.flush()
    session.add(DividendYieldSettings(green_threshold=Decimal("0.05"),
                                      red_threshold=Decimal("0.03"),
                                      price_source_interface_id=itf.id))
    await session.commit()

    svc = MarketDailyPriceSyncService(session)

    async def _fake_raw(itf_obj, params, codes):
        # 混合日期：一只正常返回今日、一只停牌返回上一交易日 → 整批必须被拦
        return [
            {"代码": "600001", "收盘": "10.5", "日期": today.strftime("%Y-%m-%d")},
            {"代码": "600002", "收盘": "9.9", "日期": "2020-01-01"},
        ]

    svc._mds._call_interface_raw = _fake_raw
    result = await svc.daily_close_fetch({})

    rows = (await session.execute(select(MarketSecurityDailyPrice))).scalars().all()
    assert rows == []  # 混合日期批次整批跳过，停牌脏价不得写入
    assert "失败批次 1" in result


# ───────────────────────── 回补 symbol 剥离（P2-2，§6.2） ─────────────────────────
@pytest.mark.asyncio
async def test_backfill_strips_exchange_prefix_from_symbol(session, monkeypatch):
    r"""守护 P2-2：历史回补传 akshare stock_zh_a_hist 的 symbol 须为纯数字（如 600000）。

    Security.code 带交易所前缀（sh600000），旧实现直接透传 sec.code 会导致上游按前缀码查无结果；
    修复后须在组装 params 时剥离非数字字符（对照 notice_scan 的 re.sub(r"\D","",code)）。
    """
    # _add_master 经 _normalize_master_code 产出的 code 带 sh/sz 前缀，与线上一致
    m = await _add_master(session, code="600000")
    assert m.code == "sh600000"  # 前置：主数据确实带前缀

    provider = SecuritiesDataProvider(
        id=_uid(), name="akshare", access_method=QuoteProviderAccessMethod.SDK,
        config={}, enabled=True,
    )
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID, name="东财历史",
        endpoint="stock_zh_a_hist", http_method="GET", enabled=True, priority=1,
        resp_code_field="代码", resp_price_field="收盘",
        response_parse={}, params={},
    )
    session.add(provider)
    await session.flush()  # 提供方先落库，接口 provider_id 外键才有归属
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    session.add(itf)
    await session.commit()

    captured: dict = {}

    async def _fake_sdk(self, itf_obj, params, codes):
        # 类级 monkeypatch → mds._fetch_sdk_raw(itf, params, codes=None) 绑定实例后
        # 依次填充 (self, itf_obj, params, codes)，缺 self 会与关键字 codes 冲突
        captured.update(params)  # 捕获实际传给 akshare 的入参
        # 返回中文列（_COL_HIST_DATE/_COL_HIST_CLOSE），让 _upsert_hist_rows 能落库
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    # 退避常量归零：mock 失败时也不真实 sleep 60/120/300s（保持测试秒级）
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,))

    result = await backfill_historical(session, itf, [m.id], date(2024, 1, 1))

    # 关键断言：symbol 必须是纯数字，交易所前缀已被剥离
    assert captured.get("symbol") == "600000"
    assert "历史回补完成" in result


# ─────────────── 回补按接口声明的 date/price 槽解析（修复腾讯源静默 0 写入） ───────────────
@pytest.mark.asyncio
async def test_backfill_uses_declared_english_response_fields(session, monkeypatch):
    """守护修复：历史回补须按接口声明的 date/price 槽取值，而非写死东财中文列。

    回归场景：新注册的 SDK 接口（如腾讯 stock_zh_a_hist_tx）声明**英文列**
    ``date``/``close``，旧实现的 ``_upsert_hist_rows`` 写死 ``日期``/``收盘`` →
    每行日期 ``parse_date`` 得 ``None`` → trace 为空 → ``return 0`` →
    **静默 0 写入**（回补报「完成」但库里没数据）。本用例修复前必 FAIL、修复后 PASS。
    """
    m = await _add_master(session, code="600000")
    provider = SecuritiesDataProvider(
        id=_uid(), name="腾讯", access_method=QuoteProviderAccessMethod.SDK,
        config={}, enabled=True,
    )
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID,
        name="腾讯-历史行情", endpoint="stock_zh_a_hist_tx", http_method="GET",
        enabled=True, priority=1,
        # 声明英文响应列：code/price/date 三槽齐全（见 response_path.compile_spec）
        response_fields=[
            {"key": "code", "slot": "code", "source": "code"},
            {"key": "close", "slot": "price", "source": "close"},
            {"key": "date", "slot": "date", "source": "date"},
        ],
        params={},
    )
    session.add(provider)
    await session.flush()  # 提供方先落库，接口 provider_id 外键才有归属
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    session.add(itf)
    await session.commit()

    async def _fake_sdk(self, itf_obj, params, codes):
        # 英文列：旧硬编码实现下每行日期取不到 → trace 空 → 静默 0 写入（修复前必 FAIL）
        return [{"date": "2024-01-02", "close": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    # 退避常量归零：保持测试秒级
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,))

    result = await backfill_historical(session, itf, [m.id], date(2024, 1, 1))

    assert "历史回补完成" in result
    rows = (await session.execute(select(MarketSecurityDailyPrice))).scalars().all()
    hit = [
        r for r in rows if r.master_id == m.id and r.trade_date == date(2024, 1, 2)
    ]
    assert len(hit) == 1, "按声明列回补须写入历史日线（修复前为静默 0 写入）"
    assert hit[0].close == Decimal("10.50")


# ───────── 回补 replace（rebuild 全量重抓）：清空窗口后重建，不留源给不到的旧行 ─────────
@pytest.mark.asyncio
@pytest.mark.parametrize("replace,expect_dropped", [(True, True), (False, False)])
async def test_backfill_replace_window_clears_stale_rows(
    session, monkeypatch, replace, expect_dropped
):
    """守护 rebuild 语义：``replace=True`` 先清空窗口内既有日线再整段写入（不留旧数据）。

    场景：库里存在源**不再返回**的日期（旧源 / 旧复权口径的残留）。
    - ``replace=True``（rebuild）→ 该行必须被删掉（这就是「清空后重建」与 upsert 的分界）；
    - ``replace=False``（legacy / gap 的 upsert）→ 该行必须原样保留。
    两种口径共同保证：源已返回的日期被覆盖为新值。
    注意窗口下限：rebuild 会下探到「该证券已有最早日期」，故早于配置起点的存量行同样落在
    清空范围内（原样保留只发生在非 replace 模式）——「源能返回时会被重建而非丢失」由
    ``test_backfill_replace_widens_window_to_earliest_existing`` 对照守护。
    """
    m = await _add_master(session, code="600000")
    provider = SecuritiesDataProvider(
        id=_uid(), name="akshare", access_method=QuoteProviderAccessMethod.SDK,
        config={}, enabled=True,
    )
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID, name="东财历史",
        endpoint="stock_zh_a_hist", http_method="GET", enabled=True, priority=1,
        resp_code_field="代码", resp_price_field="收盘",
        response_parse={}, params={},
    )
    session.add(provider)
    await session.flush()  # 提供方先落库，接口 provider_id 外键才有归属
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    session.add(itf)
    # 预置既有日线（旧源）：01-02 源会返回（应被覆盖）、01-03 源不再返回（replace 下应被删）、
    # 2023-12-29 早于配置起点（replace 下窗口下探到它 → 也在清空范围内，桩不返回它即被清掉）
    session.add_all([
        MarketSecurityDailyPrice(
            master_id=m.id, trade_date=date(2024, 1, 2), close=Decimal("1.00"),
            source="旧源",
        ),
        MarketSecurityDailyPrice(
            master_id=m.id, trade_date=date(2024, 1, 3), close=Decimal("1.11"),
            source="旧源",
        ),
        MarketSecurityDailyPrice(
            master_id=m.id, trade_date=date(2023, 12, 29), close=Decimal("0.99"),
            source="旧源",
        ),
    ])
    await session.commit()

    async def _fake_sdk(self, itf_obj, params, codes):
        # 只返回 01-02：01-03 是「源如今给不到」的日期，正是要验证是否被清掉
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    # 退避常量归零：mock 失败时也不真实 sleep（保持测试秒级）
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,))

    # force=True（rebuild/gap 的选批前提）+ 被测开关 replace
    await backfill_historical(
        session, itf, [m.id], date(2024, 1, 1), force=True, replace=replace
    )

    rows = {
        r.trade_date: r
        for r in (
            await session.execute(
                select(MarketSecurityDailyPrice).where(
                    MarketSecurityDailyPrice.master_id == m.id
                )
            )
        ).scalars().all()
    }
    # 源已返回的日期：被覆盖为新值（两种模式一致）
    assert rows[date(2024, 1, 2)].close == Decimal("10.50")
    assert rows[date(2024, 1, 2)].source == itf.name
    # 源未返回的日期：replace 清掉、非 replace 原样保留 —— 这就是两种模式的分界。
    # 其中 2023-12-29 早于配置起点，但 replace 会把窗口下限下探到该证券已有最早日期（= 它本身），
    # 故它同样落在清空范围内、因桩不返回而被清掉。
    assert (date(2024, 1, 3) not in rows) is expect_dropped
    assert (date(2023, 12, 29) not in rows) is expect_dropped


# ───── 回补 replace 的窗口下限下探：早于配置起点的存量须被「重建」而非「删掉」 ─────
@pytest.mark.asyncio
@pytest.mark.parametrize("replace,expect_widened", [(True, True), (False, False)])
async def test_backfill_replace_widens_window_to_earliest_existing(
    session, monkeypatch, replace, expect_widened
):
    """rebuild（replace）窗口下限须下探到「该证券已有最早日期」，且**抓取同宽下探**。

    场景：库里最早 2015-06-01（早于配置起点 2024-01-01），属旧源/旧复权口径的存量。
    只把**删除**窗口下探、忘了**抓取**窗口同宽，就会「删了补不回来」→ 净数据丢失；
    两处必须一起改。桩按 ``params.start_date`` 过滤返回行，故「只改删除」的实现会让
    2015-06-01 被删且不再返回 → 本用例 FAIL（这正是要拦的净数据丢失）。

    - ``replace=True``：``params.start_date`` 下探到 20150601，该行被清空后由本次抓取**重建**
      （close/source 变为新源），即「旧口径被替换」而不是「被删掉」；
    - ``replace=False``（legacy/gap 的 upsert）：``params.start_date`` 仍是配置起点 20240101，
      早于起点的那行**完全不被动**（既不删也不改）。
    """
    m = await _add_master(session, code="600000")
    provider = SecuritiesDataProvider(
        id=_uid(), name="akshare", access_method=QuoteProviderAccessMethod.SDK,
        config={}, enabled=True,
    )
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID, name="东财历史",
        endpoint="stock_zh_a_hist", http_method="GET", enabled=True, priority=1,
        resp_code_field="代码", resp_price_field="收盘",
        response_parse={}, params={},
    )
    session.add(provider)
    await session.flush()  # 提供方先落库，接口 provider_id 外键才有归属
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    session.add(itf)
    # 存量：早于配置起点（2024-01-01）的旧源行，必须来源为旧源才说明「未被动过」
    session.add(
        MarketSecurityDailyPrice(
            master_id=m.id, trade_date=date(2015, 6, 1), close=Decimal("1.00"),
            source="旧源",
        )
    )
    await session.commit()

    captured: dict = {}

    async def _fake_sdk(self, itf_obj, params, codes):
        captured.update(params)
        # 模拟数据源只返回所请求区间内的数据（桩不忽略参数，才能拦住「只改删除」的实现）
        start = str(params.get("start_date", ""))
        pool = [
            {"日期": "2015-06-01", "收盘": "7.77"},
            {"日期": "2024-01-02", "收盘": "10.50"},
        ]
        return [r for r in pool if r["日期"].replace("-", "") >= start]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    # 退避常量归零：mock 失败时也不真实 sleep（保持测试秒级）
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,))

    await backfill_historical(
        session, itf, [m.id], date(2024, 1, 1), force=True, replace=replace
    )

    # 抓取窗口是否随 replace 下探（非 replace 恒为配置起点 = 零行为变更）
    assert captured["start_date"] == ("20150601" if expect_widened else "20240101")

    rows = {
        r.trade_date: r
        for r in (
            await session.execute(
                select(MarketSecurityDailyPrice).where(
                    MarketSecurityDailyPrice.master_id == m.id
                )
            )
        ).scalars().all()
    }
    # 无净数据丢失：早于起点的那行**始终存在**——replace 下被重建，非 replace 下原样保留
    assert date(2015, 6, 1) in rows
    if expect_widened:
        assert rows[date(2015, 6, 1)].close == Decimal("7.77")  # 已被重建为新值
        assert rows[date(2015, 6, 1)].source == itf.name  # 且来源已换成新源
    else:
        assert rows[date(2015, 6, 1)].close == Decimal("1.00")  # 非 replace：完全不被动
        assert rows[date(2015, 6, 1)].source == "旧源"


# ───────────────────────── 回补断点判定（P1-3，§6.2/A15） ─────────────────────────
@pytest.mark.asyncio
async def test_backfill_gap_security_not_skipped(session, monkeypatch):
    """守护 P1-3：断点判定须用最早 trade_date——只有近期数据（中间有历史空洞）的
    证券不得被跳过；起点已覆盖的证券才跳过。旧实现 max(trade_date) >= start_date
    会把空洞证券全部误跳过。"""
    m_done = await _add_master(session, code="600001")
    m_gap = await _add_master(session, code="600002")
    # m_done：起点已覆盖（最早 2023-01-01 ≤ start）→ 跳过
    session.add(MarketSecurityDailyPrice(
        master_id=m_done.id, trade_date=date(2023, 1, 1), close=Decimal("10"),
    ))
    # m_gap：只有近期数据（最早 2025-01-01 > start）→ 历史空洞，须回补
    session.add(MarketSecurityDailyPrice(
        master_id=m_gap.id, trade_date=date(2025, 1, 1), close=Decimal("10"),
    ))
    provider = SecuritiesDataProvider(
        id=_uid(), name="akshare", access_method=QuoteProviderAccessMethod.SDK,
        config={}, enabled=True,
    )
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID, name="东财历史",
        endpoint="stock_zh_a_hist", http_method="GET", enabled=True, priority=1,
        resp_code_field="代码", resp_price_field="收盘", response_parse={}, params={},
    )
    session.add(provider)
    await session.flush()
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    session.add(itf)
    await session.commit()

    fetched: list[str] = []

    async def _fake_sdk(self, itf_obj, params, codes):
        fetched.append(params["symbol"])
        return [{"日期": "2024-06-03", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,)
    )
    # 批间冷却归零，保持测试秒级
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MIN", 0
    )
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MAX", 0
    )

    result = await backfill_historical(
        session, itf, [m_done.id, m_gap.id], date(2024, 1, 1)
    )

    assert fetched == ["600002"]  # 仅空洞证券被抓取；起点已覆盖的跳过
    assert "跳过 1 只" in result and "失败 0 只" in result


# ───────────────────────── 回补生产入口（P1-3，cfg.params.backfill_start） ─────────────────────────
async def _seed_sdk_quote_source(session):
    """造 SDK 行情源 + 配置表，返回 itf（供 daily_close_fetch 回补入口测试复用）。"""
    provider = SecuritiesDataProvider(
        id=_uid(), name="akshare", access_method=QuoteProviderAccessMethod.SDK,
        config={}, enabled=True,
    )
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID, name="东财历史",
        endpoint="stock_zh_a_hist", http_method="GET", enabled=True, priority=1,
        resp_code_field="代码", resp_price_field="收盘", response_parse={}, params={},
    )
    session.add(provider)
    await session.flush()
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    session.add(itf)
    await session.flush()
    session.add(DividendYieldSettings(green_threshold=Decimal("0.05"),
                                      red_threshold=Decimal("0.03"),
                                      price_source_interface_id=itf.id))
    return itf


@pytest.mark.asyncio
async def test_daily_close_fetch_backfill_entry_non_sdk_fails_fast(session):
    """守护 P1-3：行情源非 SDK 时配置 backfill_start → fail fast 落 FAILED。"""
    import types

    today = today_app_tz()
    session.add(MarketTradeCalendar(trade_date=today))
    m = await _add_master(session)
    session.add(
        SecurityDividend(master_id=m.id, report_year=today.year, report_quarter=1,
                         period_type=ReportPeriodType.ANNUAL,
                         cash_per_share=Decimal("1.0"), status=DividendStatus.PAID)
    )
    provider = SecuritiesDataProvider(
        id=_uid(), name="腾讯", access_method=QuoteProviderAccessMethod.HTTPS,
        config={"base_url": "https://qt.gtimg.cn"}, enabled=True,
    )
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID, name="腾讯",
        endpoint="/q", http_method="GET", enabled=True, priority=1,
        resp_code_field="代码", resp_price_field="收盘",
        response_parse={"resp_date_field": "日期", "max_codes_per_request": 800},
        params={},
    )
    session.add(provider)
    await session.flush()
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    session.add(itf)
    await session.flush()
    session.add(DividendYieldSettings(green_threshold=Decimal("0.05"),
                                      red_threshold=Decimal("0.03"),
                                      price_source_interface_id=itf.id))
    await session.commit()

    svc = MarketDailyPriceSyncService(session)

    async def _fake_raw(itf_obj, params, codes):
        return [{"代码": "600000", "收盘": "10.5", "日期": today_app_tz().isoformat()}]

    svc._mds._call_interface_raw = _fake_raw
    cfg = types.SimpleNamespace(params={"backfill_start": "2023-01-01"})
    with pytest.raises(RuntimeError, match="access_method=sdk"):
        await svc.daily_close_fetch(cfg)


@pytest.mark.asyncio
async def test_daily_close_fetch_backfill_entry_runs_hist_backfill(session, monkeypatch):
    """守护 P1-3：SDK 行情源 + backfill_start → 日抓完成后执行历史回补并写入历史行。"""
    import types

    today = today_app_tz()
    session.add(MarketTradeCalendar(trade_date=today))
    m = await _add_master(session)
    session.add(
        SecurityDividend(master_id=m.id, report_year=today.year, report_quarter=1,
                         period_type=ReportPeriodType.ANNUAL,
                         cash_per_share=Decimal("1.0"), status=DividendStatus.PAID)
    )
    await _seed_sdk_quote_source(session)
    await session.commit()

    async def _fake_sdk(self, itf_obj, params, codes):
        # 日抓（codes 非空）与回补（codes=None）共用 SDK 链路，按形状区分返回
        if codes:
            return [{"代码": "600000", "收盘": "10.5"}]
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,)
    )

    svc = MarketDailyPriceSyncService(session)
    cfg = types.SimpleNamespace(params={"backfill_start": "2023-01-01"})
    result = await svc.daily_close_fetch(cfg)

    assert "历史回补完成" in result
    rows = (await session.execute(select(MarketSecurityDailyPrice))).scalars().all()
    dates = {r.trade_date for r in rows}
    assert today in dates          # 日抓正常写入当日
    assert date(2024, 1, 2) in dates  # 回补写入历史行


# ───────────────────────── 回补单只超时上界（B 修复，_BACKFILL_FETCH_TIMEOUT） ─────────────────────────
@pytest.mark.asyncio
async def test_backfill_single_fetch_timeout_marks_failed_and_proceeds(session, monkeypatch):
    """守护 B 修复：单只 _fetch_sdk_raw 卡死（永远 sleep）应被 _BACKFILL_FETCH_TIMEOUT
    兜底超时，由 except Exception 退避重试后计为失败，整轮回补不卡死。"""
    m = await _add_master(session, code="600003")
    provider = SecuritiesDataProvider(
        id=_uid(), name="akshare", access_method=QuoteProviderAccessMethod.SDK,
        config={}, enabled=True,
    )
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID, name="东财历史",
        endpoint="stock_zh_a_hist", http_method="GET", enabled=True, priority=1,
        resp_code_field="代码", resp_price_field="收盘", response_parse={}, params={},
    )
    session.add(provider)
    await session.flush()
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    session.add(itf)
    await session.commit()

    async def _fake_sdk_sleep_forever(self, itf_obj, params, codes):
        # 模拟单只请求底层 HTTP 卡死：永不返回，逼出 _BACKFILL_FETCH_TIMEOUT
        await asyncio.sleep(9999)
        return []

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk_sleep_forever)
    # 超时上界压到极小，避免测试真实等待 60s
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_FETCH_TIMEOUT", 0.05
    )
    # 退避常量归零：超时后重试不真实 sleep 60/120/300s（保持测试秒级）
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,)
    )
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MIN", 0
    )
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MAX", 0
    )

    result = await backfill_historical(session, itf, [m.id], date(2024, 1, 1))

    # 关键：超时经 except Exception 退避重试后，该证券被计为失败、整轮不卡死并正常收尾
    assert "历史回补完成" in result
    assert "失败 1 只" in result
    # 卡死的证券不应落任何历史行
    rows = (await session.execute(select(MarketSecurityDailyPrice))).scalars().all()
    assert all(r.master_id != m.id for r in rows)


# ───────────────────────── 回补连续失败熔断（_BACKFILL_FAILURE_BREAKER） ─────────────────────────
@pytest.mark.asyncio
async def test_backfill_failure_breaker_aborts_at_threshold(session, monkeypatch):
    """连续失败达到阈值即熔断：提前抛出 RuntimeError，且只处理了阈值只（不空转全池）。

    还原真实故障场景：数据源 push2his.eastmoney.com 对本机 IP 定向拒连，单只立即失败。
    阈值压到 3，准备 10 只待回补证券——断言第 3 只失败后即刻中止、仅处理 3 只。
    """
    masters = [await _add_master(session, code=f"600{100 + i}") for i in range(10)]
    itf = await _seed_sdk_quote_source(session)
    await session.commit()

    calls: list[str] = []

    async def _fake_sdk_always_fail(self, itf_obj, params, codes):
        calls.append(params["symbol"])  # 记录实际发请求的证券
        raise RuntimeError("数据源定向拒连（模拟 push2his.eastmoney.com 拒连）")

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk_always_fail)
    # 退避常量归零：失败立即计为失败，不真实 sleep 60/120/300s
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,)
    )
    # 阈值压到 3，便于秒级验证熔断点
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_FAILURE_BREAKER", 3
    )

    with pytest.raises(RuntimeError) as excinfo:
        await backfill_historical(
            session, itf, [m.id for m in masters], date(2024, 1, 1)
        )

    msg = str(excinfo.value)
    assert "熔断" in msg and "连续失败" in msg  # 中文消息含熔断/连续失败字样
    # 关键：只处理了 3 只（阈值），而非 10 只——证明真的提前中止、未空转全池
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_backfill_failure_counter_reset_on_success(session, monkeypatch):
    """「失败2→成功1→失败2」序列、阈值 3 时不应熔断（成功使连续失败计数清零）。

    守护：成功分支必须重置 consecutive_failures，否则会被中间一次成功「误导」触发熔断。
    """
    masters = [await _add_master(session, code=f"600{200 + i}") for i in range(5)]
    itf = await _seed_sdk_quote_source(session)
    await session.commit()

    call_idx = {"n": 0}
    # 第 0、1 只失败（cf=1,2）；第 2 只成功（清零）；第 3、4 只失败（cf=1,2）→ 最大连续 2 < 3
    success_at = {2}

    async def _fake_sdk(self, itf_obj, params, codes):
        i = call_idx["n"]
        call_idx["n"] += 1
        if i in success_at:
            return [{"日期": "2024-01-02", "收盘": "10.50"}]
        raise RuntimeError("拒连")

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,)
    )
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_FAILURE_BREAKER", 3
    )

    # 不抛 RuntimeError 即证明未误触发熔断
    result = await backfill_historical(
        session, itf, [m.id for m in masters], date(2024, 1, 1)
    )
    assert "历史回补完成" in result
    assert "失败 4 只" in result  # 0/1/3/4 共 4 只失败，均未误中止


@pytest.mark.asyncio
async def test_backfill_breaker_keeps_written_rows_resumable(session, monkeypatch):
    """熔断抛出后，此前成功写入的日线行仍保留（已 commit），可断点续跑、未回滚。

    构造：前 2 只成功写入 → 后续连续失败达阈值 3 触发熔断。断言前 2 只的日线行仍在库。
    """
    masters = [await _add_master(session, code=f"600{300 + i}") for i in range(5)]
    itf = await _seed_sdk_quote_source(session)
    await session.commit()
    # 回补过程含 rollback，会使 masters 对象属性过期；先抓取纯量 id 供断言使用
    master_ids = [m.id for m in masters]

    call_idx = {"n": 0}

    async def _fake_sdk(self, itf_obj, params, codes):
        i = call_idx["n"]
        call_idx["n"] += 1
        if i < 2:  # 前两只成功写入（各自 commit）
            return [{"日期": "2024-01-02", "收盘": "10.50"}]
        raise RuntimeError("拒连")  # 第 2 只起连续失败 → 阈值 3 触发熔断

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,)
    )
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_FAILURE_BREAKER", 3
    )

    with pytest.raises(RuntimeError):
        await backfill_historical(
            session, itf, master_ids, date(2024, 1, 1)
        )

    # 熔断前成功写入的 2 只日线行仍在库（已 commit，rollback 不回滚已提交事务）
    rows = (await session.execute(select(MarketSecurityDailyPrice))).scalars().all()
    written_masters = {r.master_id for r in rows}
    assert master_ids[0] in written_masters
    assert master_ids[1] in written_masters
    # 失败的那只不应落任何行
    assert master_ids[2] not in written_masters


# ───────────────────────── 在途回补任务（形态 A，§6.2 在途任务） ─────────────────────────
@pytest.mark.asyncio
async def test_run_pending_price_backfill_no_pending_makes_no_request(session, monkeypatch):
    """守护形态 A：无在途任务（price_backfill_start_date 为空）→ 直接返回提示、不发任何请求。"""
    await _seed_sdk_quote_source(session)  # 造 settings 行（start_date 为空）
    await session.commit()

    calls = {"n": 0}

    async def _fake_sdk(self, itf_obj, params, codes):
        calls["n"] += 1
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    msg = await run_pending_price_backfill(session)
    assert calls["n"] == 0  # 零请求
    assert "无在途" in msg  # 中文提示含「无在途」


@pytest.mark.asyncio
async def test_run_pending_price_backfill_respects_quota(session, monkeypatch):
    """守护形态 A：在途 + 有未覆盖 → 只处理 ≤ quota 只（quota=2、未覆盖 5 只 → 只请求 2 只）。"""
    masters = [await _add_master(session, code=f"600{500 + i}") for i in range(5)]
    # 待补证券集合来自 security_dividends（路线 B 以分红事件表的 master_id 为全集）
    for m in masters:
        session.add(SecurityDividend(
            master_id=m.id, report_year=2024, report_quarter=1,
            period_type=ReportPeriodType.ANNUAL,
            cash_per_share=Decimal("1.0"), status=DividendStatus.PAID,
        ))
    itf = await _seed_sdk_quote_source(session)
    await session.commit()
    settings = (
        await session.execute(select(DividendYieldSettings).limit(1))
    ).scalar_one()
    settings.price_backfill_source_interface_id = itf.id
    settings.price_backfill_start_date = date(2024, 1, 1)
    settings.price_backfill_quota = 2  # 每日额度 2
    await session.commit()

    fetched: list[str] = []
    expected = {f"600{500 + i}" for i in range(5)}  # 5 只待补的纯数字代码

    async def _fake_sdk(self, itf_obj, params, codes):
        fetched.append(params["symbol"])
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,)
    )
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MIN", 0
    )
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MAX", 0
    )

    msg = await run_pending_price_backfill(session)
    # 关键：只处理 quota=2 只，而非全池 5 只
    assert len(fetched) == 2
    assert set(fetched) <= expected  # 实际发请求的都在待补集合内
    assert "在途" in msg or "回补" in msg


@pytest.mark.asyncio
async def test_run_pending_price_backfill_clears_when_all_covered(session, monkeypatch):
    """守护形态 A：在途 + 全部已覆盖 → 清空 price_backfill_start_date 且零请求（终态）。"""
    masters = [await _add_master(session, code=f"600{600 + i}") for i in range(3)]
    # 待补证券集合来自 security_dividends（路线 B 以分红事件表的 master_id 为全集）
    for m in masters:
        session.add(SecurityDividend(
            master_id=m.id, report_year=2024, report_quarter=1,
            period_type=ReportPeriodType.ANNUAL,
            cash_per_share=Decimal("1.0"), status=DividendStatus.PAID,
        ))
    itf = await _seed_sdk_quote_source(session)
    await session.commit()
    settings = (
        await session.execute(select(DividendYieldSettings).limit(1))
    ).scalar_one()
    settings.price_backfill_source_interface_id = itf.id
    settings.price_backfill_start_date = date(2024, 1, 1)
    await session.commit()
    # 全部已覆盖：每只都已有 trade_date <= start_date 的日线行
    for m in masters:
        session.add(MarketSecurityDailyPrice(
            master_id=m.id, trade_date=date(2023, 1, 1), close=Decimal("10"),
        ))
    await session.commit()

    calls = {"n": 0}

    async def _fake_sdk(self, itf_obj, params, codes):
        calls["n"] += 1
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    msg = await run_pending_price_backfill(session)
    assert calls["n"] == 0  # 零请求（补完，不发任何请求）
    # 重新读 settings：在途状态已清空（终态，此后不再跑，避免无限循环白烧配额）
    settings2 = (
        await session.execute(select(DividendYieldSettings).limit(1))
    ).scalar_one()
    assert settings2.price_backfill_start_date is None
    assert "完成" in msg or "结束" in msg


@pytest.mark.asyncio
async def test_daily_close_fetch_pending_backfill_is_noop_when_no_task(session, monkeypatch):
    """守护形态 A：无在途任务时 daily_close_fetch 不发起历史回补（backfill_historical 零调用）。

    无在途任务必须是纯 no-op：不发请求、不改数据，否则会打破既有每日抓取测试。
    """
    import app.services.market_daily_price_sync as mds

    today = today_app_tz()
    session.add(MarketTradeCalendar(trade_date=today))
    m = await _add_master(session)
    session.add(
        SecurityDividend(master_id=m.id, report_year=today.year, report_quarter=1,
                         period_type=ReportPeriodType.ANNUAL,
                         cash_per_share=Decimal("1.0"), status=DividendStatus.PAID)
    )
    await _seed_sdk_quote_source(session)  # settings 行（start_date 为空）
    await session.commit()

    called = {"n": 0}

    async def _spy(itf, master_ids, start_date):
        called["n"] += 1
        return "spy"

    monkeypatch.setattr(mds, "backfill_historical", _spy)

    svc = MarketDailyPriceSyncService(session)
    result = await svc.daily_close_fetch({})
    assert called["n"] == 0  # 无在途任务 → 不触发回补
    assert "每日额度回补" not in result  # 结果串不含在途回补段

@pytest.mark.asyncio
async def test_run_pending_price_backfill_consumes_daily_quota(session, monkeypatch):
    """额度按**自然日**消耗：同日第二次执行只能在剩余额度内，用尽则零请求。

    口径：``used_today`` 按「本批实际处理只数」累加（成败都计），跨日自动归零。
    修复前每次调用都 ``limit(quota)``，导致触发当天（手动 1 批 + 收盘价抓取续跑 1 批）
    跑掉 2×quota，与「额度是每天的」冲突。
    """
    masters = [await _add_master(session, code=f"600{700 + i}") for i in range(5)]
    for m in masters:
        session.add(SecurityDividend(
            master_id=m.id, report_year=2024, report_quarter=1,
            period_type=ReportPeriodType.ANNUAL,
            cash_per_share=Decimal("1.0"), status=DividendStatus.PAID,
        ))
    itf = await _seed_sdk_quote_source(session)
    await session.commit()
    settings = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    settings.price_backfill_source_interface_id = itf.id
    settings.price_backfill_start_date = date(2024, 1, 1)
    settings.price_backfill_quota = 2
    await session.commit()

    fetched: list[str] = []

    async def _fake_sdk(self, itf_obj, params, codes):
        fetched.append(params["symbol"])
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,))
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MIN", 0)
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MAX", 0)

    # 第一次：跑满 quota=2，并记账
    await run_pending_price_backfill(session)
    assert len(fetched) == 2
    s2 = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    assert s2.price_backfill_used_today == 2
    assert s2.price_backfill_last_run_date == today_app_tz()

    # 第二次（同一天）：余额 0 → 零请求，且不再消耗
    fetched.clear()
    msg = await run_pending_price_backfill(session)
    assert fetched == [], "当日额度用尽后不得再发请求"
    assert "额度已用尽" in msg


@pytest.mark.asyncio
async def test_run_pending_price_backfill_resets_quota_on_new_day(session, monkeypatch):
    """跨日重置：last_run_date ≠ 今天 → used_today 归零，额度恢复。"""
    masters = [await _add_master(session, code=f"600{800 + i}") for i in range(5)]
    for m in masters:
        session.add(SecurityDividend(
            master_id=m.id, report_year=2024, report_quarter=1,
            period_type=ReportPeriodType.ANNUAL,
            cash_per_share=Decimal("1.0"), status=DividendStatus.PAID,
        ))
    itf = await _seed_sdk_quote_source(session)
    await session.commit()
    settings = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    settings.price_backfill_source_interface_id = itf.id
    settings.price_backfill_start_date = date(2024, 1, 1)
    settings.price_backfill_quota = 2
    # 记账停在「很久以前」且已用满 → 今天应重置
    settings.price_backfill_last_run_date = date(2000, 1, 1)
    settings.price_backfill_used_today = 2
    await session.commit()

    fetched: list[str] = []

    async def _fake_sdk(self, itf_obj, params, codes):
        fetched.append(params["symbol"])
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,))
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MIN", 0)
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MAX", 0)

    await run_pending_price_backfill(session)
    assert len(fetched) == 2  # 重置后额度恢复，可再跑满 2 只
    s2 = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    assert s2.price_backfill_last_run_date == today_app_tz()
    assert s2.price_backfill_used_today == 2


# ─────────── 熔断批额度补记 + 失败原因回写（R3 / 3536e20） ───────────
@pytest.mark.asyncio
async def test_breaker_still_counts_burst_quota_and_writes_last_error(session, monkeypatch):
    """熔断中止时：本批额度必须照计（R3），且失败原因要回写 settings 供前端展示。

    回归点：循环末尾那句 burst 记账在 ``raise RuntimeError`` 之后不会执行；
    若不在熔断前补记，该批整体漏计 → 当日额度被低估，与「成败都计」口径不符。
    """
    masters = [await _add_master(session, code=f"600{900 + i}") for i in range(10)]
    for m in masters:
        # 待回补证券须有分红记录，_select_pending_backfill_masters 才会选中它们
        session.add(SecurityDividend(
            master_id=m.id, report_year=2024, report_quarter=1,
            period_type=ReportPeriodType.ANNUAL,
            cash_per_share=Decimal("1.0"), status=DividendStatus.PAID,
        ))
    itf = await _seed_sdk_quote_source(session)
    await session.commit()
    settings = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    settings.price_backfill_source_interface_id = itf.id
    settings.price_backfill_start_date = date(2024, 1, 1)
    settings.price_backfill_quota = 1000
    await session.commit()

    async def _always_fail(self, itf_obj, params, codes):
        raise RuntimeError("数据源定向拒连（模拟）")

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _always_fail)
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,))
    monkeypatch.setattr(
        "app.services.market_daily_price_sync._BACKFILL_FAILURE_BREAKER", 3
    )

    with pytest.raises(RuntimeError):
        await run_pending_price_backfill(session)

    s2 = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    # R3：熔断批（本 burst 分配 10 只）也要计入当日已用，不能因 raise 而漏计
    assert s2.price_backfill_used_today == 10
    # 失败原因回写，前端在「在途」旁可见
    assert s2.price_backfill_last_error is not None
    assert "熔断" in s2.price_backfill_last_error
    # 在途标记保留（可续跑），不能被熔断清掉
    assert s2.price_backfill_start_date == date(2024, 1, 1)


@pytest.mark.asyncio
async def test_rerun_clears_previous_last_error(session, monkeypatch):
    """新一轮续跑开始时应清空上一次遗留的失败原因（成功后前端不再显示旧错误）。"""
    masters = [await _add_master(session, code=f"600{950 + i}") for i in range(3)]
    for m in masters:
        session.add(SecurityDividend(
            master_id=m.id, report_year=2024, report_quarter=1,
            period_type=ReportPeriodType.ANNUAL,
            cash_per_share=Decimal("1.0"), status=DividendStatus.PAID,
        ))
    itf = await _seed_sdk_quote_source(session)
    await session.commit()
    settings = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    settings.price_backfill_source_interface_id = itf.id
    settings.price_backfill_start_date = date(2024, 1, 1)
    settings.price_backfill_quota = 1000
    # 预置「上一次熔断」的失败原因，验证新一轮开始即清空
    settings.price_backfill_last_error = "上一次熔断：连续失败 3 只"
    await session.commit()

    async def _ok(self, itf_obj, params, codes):
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _ok)
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,))
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MIN", 0)
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MAX", 0)

    await run_pending_price_backfill(session)

    s2 = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    assert s2.price_backfill_last_error is None, "续跑开始即清空旧失败原因"


# ───────────────────────── 方案 D：腾讯源自动跳过京A（BJ） ─────────────────────────
@pytest.mark.asyncio
async def test_select_pending_backfill_masters_skips_bj(session):
    """守护方案 D：传 skip_exchange='BJ' 时京A证券不入选；不传则照常入选（对照组）。"""
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
    await session.commit()

    # 有跳过：BJ 被排除，SH 保留
    pending = await _select_pending_backfill_masters(
        session, date(2024, 1, 1), 10, skip_exchange="BJ"
    )
    assert bj.id not in pending
    assert sh.id in pending

    # 对照组：不传 skip_exchange，BJ 也入选
    pending_all = await _select_pending_backfill_masters(session, date(2024, 1, 1), 10)
    assert bj.id in pending_all and sh.id in pending_all


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


@pytest.mark.asyncio
async def test_run_pending_price_backfill_skips_bj_for_tencent_source(session, monkeypatch):
    """守护方案 D 端到端：回补源为腾讯历史行情接口（stock_zh_a_hist_tx）时，京A证券不被请求。"""
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
    provider = SecuritiesDataProvider(
        id=_uid(), name="akshare-tx", access_method=QuoteProviderAccessMethod.SDK,
        config={}, enabled=True,
    )
    session.add(provider)
    await session.flush()  # provider 先落库（id 由 DB 端 gen_random_uuid 生成）
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID,
        name="腾讯-历史行情", endpoint="stock_zh_a_hist_tx", http_method="GET",
        enabled=True, priority=1,
        # 声明英文响应列：code/price/date 三槽齐全
        response_fields=[
            {"key": "code", "slot": "code", "source": "code"},
            {"key": "close", "slot": "price", "source": "close"},
            {"key": "date", "slot": "date", "source": "date"},
        ],
        params={},
    )
    session.add(itf)
    await session.flush()
    settings = DividendYieldSettings(
        green_threshold=Decimal("0.05"), red_threshold=Decimal("0.03"),
        price_source_interface_id=itf.id,
        price_backfill_source_interface_id=itf.id,
        price_backfill_start_date=date(2024, 1, 1),
        price_backfill_quota=10,
    )
    session.add(settings)
    await session.commit()

    fetched: list[str] = []

    async def _fake_sdk(self, itf_obj, params, codes):
        fetched.append(params["symbol"])
        return [{"date": "2024-01-02", "close": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_BACKOFFS", (0,))
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MIN", 0)
    monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_COOLDOWN_MAX", 0)

    await run_pending_price_backfill(session)

    # 腾讯源不含京A数据 → BJ 代码 830799 不应被请求；沪市 600000 正常回补
    assert "830799" not in fetched
    assert "600000" in fetched

