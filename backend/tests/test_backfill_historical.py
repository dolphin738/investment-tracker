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

from app.models import (
    DividendYieldSettings,
    MarketSecurityDailyPrice,
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
    run_pending_price_backfill,
)
from app.services.market_price_backfill_engine import backfill_historical



from app.services.market_daily_price_writer import _COL_HIST_CLOSE, _COL_HIST_DATE, _upsert_hist_rows
from app.models.dividend_yield import PRICE_BACKFILL_MODE_REBUILD

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
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_BACKOFFS", (0,))

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
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_BACKOFFS", (0,))

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
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_BACKOFFS", (0,))

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
    # 源未返回的日期：
    # - 中后段（2024-01-03）：replace 清掉、非 replace 原样保留 —— 这就是两种模式的分界
    #   （rebuild「不留旧数据」，源已返回的中后段整段重建）。
    # - 头部（2023-12-29，早于配置起点、恰为窗口下限）：replace 下按 P2-6 头部截断防护
    #   保留旧值（源本次仅返回 2024-01-02，头部缺失），避免「删了却补不回来」的净数据丢失；
    #   非 replace 下同样原样保留（纯 upsert 不删）。故头部行两种模式都保留。
    assert (date(2024, 1, 3) not in rows) is expect_dropped
    assert date(2023, 12, 29) in rows  # 头部行：两种模式都保留（P2-6 头部防护 / 纯 upsert 不删）


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
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_BACKOFFS", (0,))

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
        "app.services.market_price_backfill_engine._BACKFILL_BACKOFFS", (0,)
    )
    # 批间冷却归零，保持测试秒级
    monkeypatch.setattr(
        "app.services.market_price_backfill_engine._BACKFILL_COOLDOWN_MIN", 0
    )
    monkeypatch.setattr(
        "app.services.market_price_backfill_engine._BACKFILL_COOLDOWN_MAX", 0
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
    session.add(DividendYieldSettings(
                                      price_source_interface_id=itf.id))
    return itf



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
        "app.services.market_price_backfill_engine._BACKFILL_FETCH_TIMEOUT", 0.05
    )
    # 退避常量归零：超时后重试不真实 sleep 60/120/300s（保持测试秒级）
    monkeypatch.setattr(
        "app.services.market_price_backfill_engine._BACKFILL_BACKOFFS", (0,)
    )
    monkeypatch.setattr(
        "app.services.market_price_backfill_engine._BACKFILL_COOLDOWN_MIN", 0
    )
    monkeypatch.setattr(
        "app.services.market_price_backfill_engine._BACKFILL_COOLDOWN_MAX", 0
    )

    result = await backfill_historical(session, itf, [m.id], date(2024, 1, 1))

    # 关键：超时经 except Exception 退避重试后，该证券被计为失败、整轮不卡死并正常收尾
    assert "历史回补完成" in result
    assert "失败 1 只" in result
    # 卡死的证券不应落任何历史行
    rows = (await session.execute(select(MarketSecurityDailyPrice))).scalars().all()
    assert all(r.master_id != m.id for r in rows)


# ───────────────────────── 回补连续失败熔断（_BACKFILL_FAILURE_BREAKER） ─────────────────────────

_REBUILD_CURSOR_MIN = "00000000-0000-0000-0000-000000000000"



async def _seed_rebuild_run(session, *, run_token):
    """造 rebuild 在途 run：SDK 回补源 + 3 只有分红证券 + rebuild 模式 + 游标置于最小值。"""
    itf = await _seed_sdk_quote_source(session)
    masters = [await _add_master(session, code=f"600{320 + i}") for i in range(3)]
    for m in masters:
        session.add(
            SecurityDividend(
                master_id=m.id, report_year=date(2023, 1, 1).year, report_quarter=4,
                period_type=ReportPeriodType.ANNUAL,
                cash_per_share=Decimal("1.0"), status=DividendStatus.PAID,
            )
        )
    settings = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    settings.price_backfill_source_interface_id = itf.id
    settings.price_backfill_mode = PRICE_BACKFILL_MODE_REBUILD
    settings.price_backfill_start_date = date(2024, 1, 1)
    settings.price_backfill_quota = 10
    settings.price_backfill_run_token = run_token
    settings.price_backfill_rebuild_cursor = _REBUILD_CURSOR_MIN
    await session.commit()
    return masters



@pytest.mark.asyncio
async def test_rebuild_abort_does_not_advance_cursor(session, monkeypatch):
    """P2-1 回归：rebuild 批中途世代标记失效（模拟取消 / 被新一次触发取代）→ 优雅中止，
    **不得**推进 ``price_backfill_rebuild_cursor``。

    否则会覆盖 DELETE 端点「取消即放弃本轮重抓进度」的清零意图；且「取消 → 立刻重新触发」
    时老批次收尾写回的游标可能被新 run 读到 → 从旧批尾部续跑、跳过池首一段
    （该段保留旧复权口径），与 rebuild「全量重抓」的目的相悖。
    """
    await _seed_rebuild_run(session, run_token="ORIGINAL-TOKEN")

    calls: list[str] = []

    async def _fake_sdk(self, itf_obj, params, codes):
        calls.append(params["symbol"])
        if len(calls) == 1:
            cur = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
            cur.price_backfill_run_token = None  # 模拟被取消
            await session.commit()
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_BACKOFFS", (0,))

    msg = await run_pending_price_backfill(session)

    assert len(calls) == 1, "世代标记失效后不得继续抓取剩余证券"
    assert "已中止" in msg
    session.expire_all()  # 强制读库，避免 identity map 旧值掩盖「被写回」
    cur = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    assert cur.price_backfill_rebuild_cursor == _REBUILD_CURSOR_MIN, (
        "中止（取消 / 被取代）不得推进 rebuild 游标"
    )



@pytest.mark.asyncio
async def test_rebuild_success_advances_cursor(session, monkeypatch):
    """P2-1 反向对照：非在途链路（``run_token=None``）正常跑完 → 游标**照旧推进**
    （守护零行为变更；若误写成「无条件不推进」会在此 FAIL）。"""
    await _seed_rebuild_run(session, run_token=None)

    async def _fake_sdk(self, itf_obj, params, codes):
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_BACKOFFS", (0,))
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_COOLDOWN_MIN", 0)
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_COOLDOWN_MAX", 0)

    msg = await run_pending_price_backfill(session)

    assert "已中止" not in msg
    session.expire_all()
    cur = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    assert cur.price_backfill_rebuild_cursor not in (None, _REBUILD_CURSOR_MIN), (
        "本批成功完成后必须推进 rebuild 游标到 pending[-1]"
    )


# ───── P2-2：cfg.params.backfill_start 定时入口也走执行租约（跨调度并发防护） ─────

@pytest.mark.asyncio
async def test_rebuild_cancel_during_last_fetch_still_does_not_advance_cursor(
    session, monkeypatch
):
    """P2-1 残余窗口**主回归**：取消恰好发生在**最后一只**证券的抓取期间时，三个检查点都
    覆盖不到，``backfill_historical`` 按正常完成返回普通 ``str``（非 ``AbortSummary``）；
    此处必须靠推进游标前的**二次校验世代标记**闭合——``price_backfill_rebuild_cursor``
    仍**不得**推进（与「中止不推进」的语义一致）。"""
    masters = await _seed_rebuild_run(session, run_token="ORIGINAL-TOKEN")

    calls: list[str] = []

    async def _fake_sdk(self, itf_obj, params, codes):
        calls.append(params["symbol"])
        if len(calls) == len(masters):  # 第 N 只（最后一只）抓取期间才取消
            cur = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
            cur.price_backfill_run_token = None
            await session.commit()
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_BACKOFFS", (0,))

    msg = await run_pending_price_backfill(session)

    # 三只都抓了（无检查点触发中止）→ 走的是**正常完成分支**，不产生 AbortSummary
    assert len(calls) == len(masters), "本窗口不清空已抓取行为，最后一只会被抓"
    assert "已中止" not in msg, "正常完成分支不产生 AbortSummary（这正是残余窗口的成因）"
    session.expire_all()
    cur = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    assert cur.price_backfill_rebuild_cursor == _REBUILD_CURSOR_MIN, (
        "收尾期间世代标记失效（最后一只抓取中取消）→ 二次校验必须挡住游标推进"
    )



@pytest.mark.asyncio
async def test_rebuild_cursor_advances_without_run_token_even_if_token_changed(
    session, monkeypatch
):
    """P2-1 残余窗口**反向对照（零行为变更）**：非在途链路（``run_token=None``）即便库内
    世代标记在收尾期间被改写，``_backfill_run_still_valid`` 也恒为 True → 游标**照旧推进**。
    守护加固未把「非在途链路」的正常推进也误挡掉。"""
    masters = await _seed_rebuild_run(session, run_token=None)

    calls: list[str] = []

    async def _fake_sdk(self, itf_obj, params, codes):
        calls.append(params["symbol"])
        if len(calls) == len(masters):
            cur = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
            cur.price_backfill_run_token = "SOMEONE-ELSE"  # 被改写亦不影响（run_token 为 None）
            await session.commit()
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_BACKOFFS", (0,))
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_COOLDOWN_MIN", 0)
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_COOLDOWN_MAX", 0)

    msg = await run_pending_price_backfill(session)

    assert "已中止" not in msg
    assert len(calls) == len(masters)
    session.expire_all()
    cur = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    assert cur.price_backfill_rebuild_cursor not in (None, _REBUILD_CURSOR_MIN), (
        "run_token=None（非在途链路）时必须照旧推进游标，零行为变更"
    )



@pytest.mark.asyncio
async def test_rebuild_cursor_advances_when_token_still_valid(session, monkeypatch):
    """P2-1 残余窗口**对照**：在途链路（``run_token`` 有效）正常跑完 → 二次校验通过 →
    游标**推进**（确认加固没有把正常路径也一并挡掉）。"""
    masters = await _seed_rebuild_run(session, run_token="ORIGINAL-TOKEN")

    calls: list[str] = []

    async def _fake_sdk(self, itf_obj, params, codes):
        calls.append(params["symbol"])
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_BACKOFFS", (0,))
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_COOLDOWN_MIN", 0)
    monkeypatch.setattr("app.services.market_price_backfill_engine._BACKFILL_COOLDOWN_MAX", 0)

    msg = await run_pending_price_backfill(session)

    assert "已中止" not in msg
    assert len(calls) == len(masters)
    session.expire_all()
    cur = (await session.execute(select(DividendYieldSettings).limit(1))).scalar_one()
    assert cur.price_backfill_rebuild_cursor not in (None, _REBUILD_CURSOR_MIN), (
        "世代标记仍有效 + 正常完成 → 游标必须推进（加固不得误挡正常路径）"
    )


# ───────── P2-6：源响应头部截断 → replace_window 整窗删除降级为纯 upsert ─────────
@pytest.mark.asyncio
async def test_upsert_hist_rows_replace_window_head_truncation_keeps_old_rows(session):
    """P2-6 回归：源响应头部截断时，replace_window 整窗删除降级为纯 upsert。

    既有日线 [d1, d2, d3]（d1 最早）；源本次只返回 [d2, d3]（头部截断，d1 缺失）。
    replace_window=(d1, d3)。由于 ``min(trace)=d2 > d1=窗口下限``，判定为头部截断 →
    跳过整窗删除、降级为纯 upsert：d1 必须保留（不被误删），d2/d3 被本次值覆盖。
    """
    m = await _add_master(session, code="600000")
    mid = m.id
    d1 = date(2023, 1, 1)
    d2 = date(2023, 1, 2)
    d3 = date(2023, 1, 3)
    for d, c in [(d1, "11.0"), (d2, "12.0"), (d3, "13.0")]:
        session.add(
            MarketSecurityDailyPrice(
                master_id=mid, trade_date=d, close=Decimal(c), source="旧源"
            )
        )
    await session.commit()
    session.expire_all()

    new_rows = [
        {_COL_HIST_DATE: "2023-01-02", _COL_HIST_CLOSE: "22.0"},
        {_COL_HIST_DATE: "2023-01-03", _COL_HIST_CLOSE: "23.0"},
    ]
    written = await _upsert_hist_rows(
        session, mid, new_rows, "newsrc", replace_window=(d1, d3)
    )
    assert written == 2

    rows = {
        r.trade_date: r
        for r in (
            await session.execute(
                select(MarketSecurityDailyPrice).where(
                    MarketSecurityDailyPrice.master_id == mid
                )
            )
        ).scalars().all()
    }
    # 头部截断：d1 不应被删除（降级为纯 upsert）
    assert d1 in rows, "头部截断时既有最旧行 d1 必须保留，不得被整窗删除误删"
    assert rows[d1].close == Decimal("11.0")
    assert rows[d1].source == "旧源"
    # d2/d3 被本次值覆盖（纯 upsert 只覆盖本次给到的日期）
    assert rows[d2].close == Decimal("22.0")
    assert rows[d2].source == "newsrc"
    assert rows[d3].close == Decimal("23.0")
    assert rows[d3].source == "newsrc"
