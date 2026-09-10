"""股息率采集服务核心逻辑单测（mock 网络层，不触真实 akshare/东财）。

守护方案 §3.2 状态映射五值表 / §6.1 季末 guard 与断点续抓 / §6.3 五年留存清理边界 /
§6.4 派生快照重算 / §5.5 交易日历（决策 A9）。复用既有 ``session`` fixture
（backend/conftest.py），网络层全部 monkeypatch。
"""
from __future__ import annotations

import sys
import uuid
from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.date_utils import today_app_tz
from app.models import (
    MarketSecurityDailyPrice,
    MarketTradeCalendar,
    Security,
    SecurityDividend,
    SecurityDividendYield,
)
from app.models.enums import DividendStatus, DividendYieldMode, ReportPeriodType, SecurityType
from app.core.date_utils import parse_date
from app.services.dividend_period import (
    back_n_quarters,
    current_quarter,
    is_future_period,
    parse_cash,
    parse_report_period,
)
from app.services.dividend_sync import (
    DividendSyncService,
    _STATUS_MAP,
)
from app.services.dividend_yield_refresh import (
    is_trade_day,
    refresh_trade_calendar,
    refresh_yields_for_masters,
)

def _uid() -> str:
    return str(uuid.uuid4())


async def _add_master(session, code="sh600000", name="浦发银行"):
    m = Security(id=_uid(), code=code, name=name, asset_class=SecurityType.STOCK)
    session.add(m)
    await session.flush()
    return m


def _div(master_id, year, quarter, cash, status=DividendStatus.PAID,
         ptype=ReportPeriodType.ANNUAL, ex=None):
    return SecurityDividend(
        master_id=master_id,
        report_year=year,
        report_quarter=quarter,
        period_type=ptype,
        cash_per_share=Decimal(cash),
        status=status,
        ex_dividend_date=ex,
    )


# ───────────────────────── 解析函数 + _STATUS_MAP（§3.2 / A.2） ─────────────────────────
def test_status_map_exact_match_cancel_is_rejected():
    """守护附录 A.2 / §3.2：五值精确映射；「取消分配」→ REJECTED 而非 PAID（防方向性错误）。"""
    assert _STATUS_MAP == {
        "实施分配": DividendStatus.PAID,
        "预披露": DividendStatus.PROPOSED,
        "董事会决议通过": DividendStatus.PROPOSED,
        "取消分配": DividendStatus.REJECTED,
        "股东大会否决": DividendStatus.REJECTED,
    }
    assert _STATUS_MAP["取消分配"] is DividendStatus.REJECTED
    assert _STATUS_MAP["实施分配"] is DividendStatus.PAID
    # 精确匹配：含「分配」字样的未登记值不得误判
    assert "分配" not in _STATUS_MAP
    assert _STATUS_MAP.get("未识别进度", "default") == "default"


def testparse_date_variants_and_garbage():
    """守护 §6.1：日期解析支持 YYYYMMDD / YYYY-MM-DD / 带分隔连字符；脏值返回 None。"""
    assert parse_date("20241214") == date(2024, 12, 14)
    assert parse_date("2024-12-14") == date(2024, 12, 14)
    assert parse_date(None) is None
    assert parse_date("") is None
    assert parse_date("-") is None
    assert parse_date("nan") is None
    assert parse_date("2024-13-40") is None  # 非法月份/日
    assert parse_date(20241214) == date(2024, 12, 14)  # 数字下标行也兼容


def testparse_cash_per_share_divide_by_ten():
    """守护 §6.1：'现金分红比例'（每 10 股派 X 元）→ 每股（÷10）；'-' 等脏值 None。"""
    assert parse_cash("25") == Decimal("2.5")
    assert parse_cash("0.5") == Decimal("0.05")
    assert parse_cash(None) is None
    assert parse_cash("-") is None
    assert parse_cash("abc") is None


def test_parse_cash_nan_is_missing():
    """守护 §3.5 / 迁移 0010：上游缺失金额返回 "NaN" → 归一为 None，不落库。

    ``Decimal("NaN")`` 是**合法构造**（不抛 InvalidOperation），旧解析未拦导致
    NaN 落库并污染快照分子（2026-09-08 排查 600339：359 行分红 + 121 行快照）。
    本用例是「源头修复」的回归护栏：大小写两种形态都必须归 None。
    """
    # 大写形态（旧白名单只做 in (None,"","-") 判断，两种形态都会构造出 NaN）
    assert parse_cash("NaN") is None
    assert parse_cash("nan") is None
    assert parse_cash(" NaN ") is None  # 带空白同样命中
    # 反例：有效值不被误伤
    assert parse_cash("25") == Decimal("2.5")


def testparse_report_period_quarters():
    """守护 §6.1：3331/630/0930/1231 映射到 Q1-Q4；非法报告期 None（跳行）。"""
    assert parse_report_period("20241231") == (2024, 4)
    assert parse_report_period("20240630") == (2024, 2)
    assert parse_report_period("20240930") == (2024, 3)
    assert parse_report_period(20240331) == (2024, 1)
    assert parse_report_period("202412") == (2024, 4)  # 长度为 6 的 YYYYMM
    assert parse_report_period(None) is None
    assert parse_report_period("xxxx") is None
    assert parse_report_period("20240531") is None  # 5 月不在季度末集合


def testback_n_quarters_cross_year():
    """守护 §6.1：报告期回退 N 季跨年末尾衔接。"""
    assert back_n_quarters(2026, 1, 1) == (2025, 4)
    assert back_n_quarters(2026, 1, 4) == (2025, 1)
    assert back_n_quarters(2026, 4, 0) == (2026, 4)


# ───────────────────────── 季末 guard（§6.1 决策 A5） ─────────────────────────
@pytest.mark.asyncio
async def test_quarterly_fetch_non_quarter_end_skips(session, monkeypatch):
    """守护 §6.1：非季度末日直接跳过并返回串（不触碰配置/网络）。"""
    from app.services import dividend_sync as ds

    monkeypatch.setattr(ds, "today_app_tz", lambda: date(2026, 7, 15))  # 非 3/6/9/12 月末
    svc = DividendSyncService(session)
    result = await svc.quarterly_fetch({})
    assert "非季度末日" in result
    assert "2026-07-15" in result


# ───────────────────────── 断点续抓（§6.1） ─────────────────────────
@pytest.mark.asyncio
async def test_pending_periods_missing_plus_recent(session):
    """守护 §6.1：待抓 = 缺失集合 ∪ 最近 4 期；已有的最近期不被重复。"""
    m = await _add_master(session)
    session.add(_div(m.id, today_app_tz().year, 4, "1.0"))
    session.add(_div(m.id, today_app_tz().year - 1, 4, "1.0"))
    await session.commit()

    today = today_app_tz()
    svc = DividendSyncService(session)
    periods = await svc._pending_periods(today)
    out = set(periods)
    cur = today.year
    # 缺失的全量老财年格子应在列（如 cur-2 全年）
    assert (cur - 2, 1) in out and (cur - 2, 4) in out
    # 最近 4 期重刷含当期与往前 3 季（尚未到达的未来期次不参与断言，见下方专项用例）
    for p in [(cur, 4), (cur, 3), (cur, 2), (cur, 1)]:
        if is_future_period(p[0], p[1], today):
            continue
        assert p in out
    # 非缺失、非最近期的既有格子不在列（cur-1 Q4 属既有）
    assert (cur - 1, 4) not in out
    # 未来期次一律不在列（源站无数据，抓取必失败）
    assert not [p for p in out if is_future_period(p[0], p[1], today)]


# ───────────────────────── 派生快照重算（§2.5 / §6.4 / §9 一致性） ─────────────────────────
@pytest.mark.asyncio
async def test_refresh_yields_with_and_without_price(session):
    """守护 §6.4：有价格 → 算 yield；无价格 → None（缺失非 0）；快照字段齐全。"""
    m = await _add_master(session)
    cur = today_app_tz().year
    session.add(_div(m.id, cur, 4, "1.0"))  # 年报 Q4 → TTM，分子 1.0
    session.add(MarketSecurityDailyPrice(master_id=m.id, trade_date=date(cur, 9, 1), close=Decimal("10")))
    await session.commit()

    await refresh_yields_for_masters(session, [m.id])
    snap = (
        await session.execute(
            select(SecurityDividendYield).where(SecurityDividendYield.master_id == m.id)
        )
    ).scalar_one()
    assert snap.mode == DividendYieldMode.TTM
    assert snap.dividend_yield == Decimal("0.1")
    assert snap.numerator_per_share == Decimal("1.0")
    assert snap.latest_price == Decimal("10")
    assert snap.latest_trade_date == date(cur, 9, 1)
    assert snap.consecutive_years >= 1
    assert snap.last_dividend_year == cur
    assert snap.suspicious is False
    assert snap.stale is False
    assert snap.ref_div_ids is not None

    # 无价格证券：dividend_yield None（缺失非 0）
    m2 = await _add_master(session, code="sz000858", name="五粮液")
    session.add(_div(m2.id, cur, 4, "2.0"))
    await session.commit()
    await refresh_yields_for_masters(session, [m2.id])
    snap2 = (
        await session.execute(
            select(SecurityDividendYield).where(SecurityDividendYield.master_id == m2.id)
        )
    ).scalar_one()
    assert snap2.dividend_yield is None
    assert snap2.numerator_per_share == Decimal("2.0")
    assert snap2.latest_price is None


# ───────────────────────── 五年留存清理（§6.3 决策 C5） ─────────────────────────
@pytest.mark.asyncio
async def test_retention_cleanup_report_year_boundary(session, monkeypatch):
    """守护决策 C5 / §6.3：按 report_year 清理（PROPOSED/REJECTED 也删）；日线按 trade_date 保 2 年。"""
    from app.services import dividend_sync as ds

    async def _noop_calendar(sess):
        return None

    monkeypatch.setattr(ds, "refresh_trade_calendar", _noop_calendar)

    m = await _add_master(session)
    cur = today_app_tz().year
    cutoff = cur - 4  # 真 5 年窗口 = [cur-4, cur]，删除 report_year < cutoff
    # 窗口外的旧 PROPOSED（report_year = cutoff-1 = cur-5）必须被删除
    session.add(_div(m.id, cutoff - 1, 4, "1.0", status=DividendStatus.PROPOSED, ex=None))
    # 旧 REJECTED（cur-5）同样被删
    session.add(_div(m.id, cutoff - 1, 2, "1.0", status=DividendStatus.REJECTED))
    # 边界值 cur-4（= cutoff）必须保留 —— 真 5 年而非 6 年
    session.add(_div(m.id, cutoff, 4, "1.0", status=DividendStatus.PROPOSED, ex=None))
    # 新 PAID 保留
    session.add(_div(m.id, cur, 4, "1.0"))
    # 超 2 年的日线删除、新日线保留
    old_price_d = date(cur - 3, 1, 1)
    new_price_d = date(cur, 9, 1)
    session.add(MarketSecurityDailyPrice(master_id=m.id, trade_date=old_price_d, close=Decimal("9")))
    session.add(MarketSecurityDailyPrice(master_id=m.id, trade_date=new_price_d, close=Decimal("10")))
    await session.commit()

    svc = DividendSyncService(session)
    result = await svc.retention_cleanup({})

    remaining = (
        await session.execute(select(SecurityDividend))
    ).scalars().all()
    assert {r.report_year for r in remaining} == {cur - 4, cur}  # 边界 cur-4 保留、cur-5 删除
    prices = (
        await session.execute(select(MarketSecurityDailyPrice))
    ).scalars().all()
    assert {p.trade_date for p in prices} == {new_price_d}  # 旧日线被清
    assert "五年留存清理完成" in result


# ───────────────────────── 东向去重（§6.1 / 附录 A.7 唯一键） ─────────────────────────
@pytest.mark.asyncio
async def test_eastward_dedup_by_ex_date_and_by_identity(session):
    """守护 §6.1：报告期行上岗前删同 master 匹配 SPECIAL 行（ex_date 或 (year,quarter,cash) 全等）。"""
    m = await _add_master(session)
    cur = today_app_tz().year
    sp1 = _div(m.id, cur, 4, "19.0", ptype=ReportPeriodType.SPECIAL, ex=date(cur, 12, 27))
    session.add(sp1)
    await session.commit()

    svc = DividendSyncService(session)
    # ex_date 相等 → 删
    await svc._eastward_dedup(m.id, date(cur, 12, 27), cur, 4, Decimal("19.0"))
    await session.commit()
    cnt = (
        await session.execute(select(SecurityDividend).where(SecurityDividend.master_id == m.id))
    ).scalars().all()
    assert cnt == []

    # (year, quarterly, cash) 全等（ex_date None 分支）
    sp2 = _div(m.id, cur, 2, "2.0", ptype=ReportPeriodType.SPECIAL, ex=None)
    session.add(sp2)
    await session.commit()
    await svc._eastward_dedup(m.id, None, cur, 2, Decimal("2.0"))
    await session.commit()
    left = (
        await session.execute(select(SecurityDividend).where(SecurityDividend.master_id == m.id))
    ).scalars().all()
    assert left == []


# ───────────────────────── 交易日历（§5.5 决策 A9） ─────────────────────────
@pytest.mark.asyncio
async def test_is_trade_day_empty_fail_open(session):
    """守护决策 A9：日历表空 → FAIL-OPEN 返回 True（交给防线二）。"""
    assert await is_trade_day(session, today_app_tz()) is True


@pytest.mark.asyncio
async def test_is_trade_day_lookup(session):
    """守护 §5.5：日历含该日 → True；否则 False。"""
    d = date(2026, 9, 4)
    session.add(MarketTradeCalendar(trade_date=d))
    await session.commit()
    assert await is_trade_day(session, d) is True
    assert await is_trade_day(session, d + timedelta(days=1)) is False


class _FakeCol:
    def __init__(self, vals):
        self.vals = vals

    def tolist(self):
        return self.vals


class _FakeAk:
    """mock akshare.tool_trade_date_hist_sina 返回的 DataFrame 替身。"""

    def tool_trade_date_hist_sina(self):
        cur = today_app_tz().year
        return _DFState(
            ["%04d%02d%02d" % (cur, 9, 3), "%04d%02d%02d" % (cur, 9, 4), "%d1231" % (cur + 5)]
        )


class _DFState:
    def __init__(self, raw_dates):
        self._raw = _FakeCol(raw_dates)
        self.empty = not raw_dates

    @property
    def columns(self):
        return ["trade_date"]

    def __getitem__(self, key):
        return self._raw


@pytest.mark.asyncio
async def test_refresh_trade_calendar_filters_by_horizon(session, monkeypatch):
    """守护 §5.5 / 决策 A9：刷新交易日历，未来 2 年外与过于久远者过滤不落库。"""
    monkeypatch.setitem(sys.modules, "akshare", _FakeAk())
    await refresh_trade_calendar(session)
    await session.commit()

    cur = today_app_tz().year
    dates = {
        r[0]
        for r in (
            await session.execute(select(MarketTradeCalendar.trade_date))
        ).all()
    }
    assert date(cur, 9, 3) in dates
    assert date(cur, 9, 4) in dates
    assert date(cur + 5, 12, 31) not in dates  # 超出 horizon 过滤

# ───────────────────────── §7 stale 治理（update_stale_flags，P1-2） ─────────────────────────
@pytest.mark.asyncio
async def test_update_stale_flags_lags_3_trade_days(session):
    """守护 §7：落后基准 ≥3 个已记录交易日 → stale=True；不足 3 个交易日 → False。"""
    from datetime import datetime, timezone as tz

    from app.services.dividend_yield_refresh import update_stale_flags

    d1, d2, d3, d4, d5 = (date(2026, 1, 5 + i) for i in range(5))
    for d in (d1, d2, d3, d4, d5):
        session.add(MarketTradeCalendar(trade_date=d))
    m1 = await _add_master(session, code="sh600001")
    m2 = await _add_master(session, code="sh600002")
    session.add(
        SecurityDividendYield(
            master_id=m1.id, mode=DividendYieldMode.TTM,
            numerator_per_share=Decimal("1.0"),
            latest_trade_date=d1,  # 早于基准往前第 3 个交易日 d3 → stale
            computed_at=datetime.now(tz.utc),
        )
    )
    session.add(
        SecurityDividendYield(
            master_id=m2.id, mode=DividendYieldMode.TTM,
            numerator_per_share=Decimal("1.0"),
            latest_trade_date=d4,  # 仅落后 1 个交易日 → 不 stale
            computed_at=datetime.now(tz.utc),
        )
    )
    await session.commit()

    flagged = await update_stale_flags(session)

    rows = (await session.execute(select(SecurityDividendYield))).scalars().all()
    by_mid = {r.master_id: r for r in rows}
    assert by_mid[m1.id].stale is True
    assert by_mid[m2.id].stale is False
    assert flagged == 1


@pytest.mark.asyncio
async def test_update_stale_flags_insufficient_base_noop(session):
    """守护 §7 降级：日历基准不足 3 个交易日时无从判定，不动任何行。"""
    from datetime import datetime, timezone as tz

    from app.services.dividend_yield_refresh import update_stale_flags

    session.add(MarketTradeCalendar(trade_date=date(2026, 1, 5)))
    m = await _add_master(session, code="sh600003")
    session.add(
        SecurityDividendYield(
            master_id=m.id, mode=DividendYieldMode.TTM,
            numerator_per_share=Decimal("1.0"),
            latest_trade_date=date(2020, 1, 1),
            computed_at=datetime.now(tz.utc),
        )
    )
    await session.commit()

    flagged = await update_stale_flags(session)

    assert flagged == 0
    row = (await session.execute(select(SecurityDividendYield))).scalars().one()
    assert row.stale is False


@pytest.mark.asyncio
async def test_quarterly_fetch_manual_force_bypasses_guard(session, monkeypatch):
    """守护 P1-2（§7 冷启动）：手动触发（force=True）跳过季末 guard，进入抓取主流程。

    非季末日 + force=False → 仍被 guard 拦（回归守护）；force=True → 越过 guard
    继续执行（此处用「配置表为空」的 fail fast 证明已越过 guard，而非返回跳过串）。
    """
    from app.services import dividend_sync as ds

    monkeypatch.setattr(ds, "today_app_tz", lambda: date(2026, 7, 15))
    svc = DividendSyncService(session)
    result = await svc.quarterly_fetch({})
    assert "非季度末日" in result  # 定时触发语义不变
    with pytest.raises(RuntimeError, match="配置表为空"):
        await svc.quarterly_fetch({}, force=True)  # 手动触发越过 guard


# ───────────────────────── P2-1 东向去重 OR 语义 / P2-2 同格多行告警 ─────────────────────────
@pytest.mark.asyncio
async def test_eastward_dedup_or_semantics_deletes_identity_match_with_ex_date(session):
    """守护 P2-1（§6.1 OR 语义）：SPECIAL 行 ex_date 不同但 (y,q,cash) 全等也须删除。

    旧实现 ex_date 非空时只按 ex_date 匹配——三元组全等的预案行漏删（预案窗口双计）。
    """
    m = await _add_master(session)
    cur = today_app_tz().year
    # 预案行：无 ex_date，(cur, 4, 19.0) 三元组
    sp = _div(m.id, cur, 4, "19.0", status=DividendStatus.PROPOSED,
              ptype=ReportPeriodType.SPECIAL, ex=None)
    session.add(sp)
    await session.commit()

    svc = DividendSyncService(session)
    # 报告期行 ex_date=12/27 与预案行（ex=None）不同，但 (y,q,cash) 全等 → 仍须删
    await svc._eastward_dedup(m.id, date(cur, 12, 27), cur, 4, Decimal("19.0"))
    await session.commit()
    left = (
        await session.execute(select(SecurityDividend).where(SecurityDividend.master_id == m.id))
    ).scalars().all()
    assert left == []


@pytest.mark.asyncio
async def test_upsert_dividend_batch_duplicate_cell_warns(session, caplog):
    """守护 P2-2（§12）：源返回同格多行须告警（保留末行，不静默）。"""
    import logging

    from app.models import InterfaceCategory, QuoteInterface
    from app.models.enums import QuoteProviderAccessMethod
    from app.models.quote_provider import SecuritiesDataProvider
    from app.services.market_data_sync import DIVIDEND_LIST_CAT_ID

    m = await _add_master(session, code="sh600001")
    provider = SecuritiesDataProvider(
        id=_uid(), name="东财", access_method=QuoteProviderAccessMethod.SDK,
        config={}, enabled=True,
    )
    category = InterfaceCategory(id=DIVIDEND_LIST_CAT_ID, label="分红配送", system=True)
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=DIVIDEND_LIST_CAT_ID,
        name="东财-分红配送", endpoint="xxx", http_method="GET", enabled=True,
        priority=1, resp_code_field="代码", response_parse={}, params={},
    )
    session.add_all([provider, category])
    await session.flush()  # 提供方/分类先落库，接口外键才有归属
    session.add(itf)
    await session.commit()

    cur = today_app_tz().year
    rows = [
        {"代码": "600001", "报告期": f"{cur}-12-31",
         "现金分红-现金分红比例": "1.0", "方案进度": "实施分配",
         "除权除息日": None, "股权登记日": None},
        {"代码": "600001", "报告期": f"{cur}-12-31",
         "现金分红-现金分红比例": "1.5", "方案进度": "实施分配",
         "除权除息日": None, "股权登记日": None},
    ]
    svc = DividendSyncService(session)
    with caplog.at_level(logging.WARNING, logger="app.services.dividend_sync"):
        changed = await svc._upsert_dividend_batch(itf, rows, cur, 4)
    assert set(changed) == {m.id}  # 同格两行：变更集合仍只含该 master（changed 允许重复）
    assert any("同格多行" in rec.message for rec in caplog.records)
    # 末行覆盖语义不变
    row = (
        await session.execute(select(SecurityDividend).where(SecurityDividend.master_id == m.id))
    ).scalars().one()
    # parse_cash 按「10派X元」折算每股：源值 1.5 → 每股 0.15（末行覆盖）
    assert row.cash_per_share == Decimal("0.15")


@pytest.mark.asyncio
async def test_upsert_dividend_batch_falls_back_to_chinese_code_field(session):
    """守护：``resp_code_field`` 配错（遗留值 'code'）时回退中文列名，不得全量跳行。

    缺陷实测：配置 'code' + 源返回中文列 → 每行 ``row.get('code')`` 为 None →
    ``mids == []`` → 「抓取上万行、0 条落库」。迁移 0009 修数据，本例守护代码侧兜底。
    """
    from app.models import InterfaceCategory, QuoteInterface
    from app.models.enums import QuoteProviderAccessMethod
    from app.models.quote_provider import SecuritiesDataProvider
    from app.services.market_data_sync import DIVIDEND_LIST_CAT_ID

    m = await _add_master(session, code="sh600001")
    provider = SecuritiesDataProvider(
        id=_uid(), name="东财", access_method=QuoteProviderAccessMethod.SDK,
        config={}, enabled=True,
    )
    category = InterfaceCategory(id=DIVIDEND_LIST_CAT_ID, label="分红配送", system=True)
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=DIVIDEND_LIST_CAT_ID,
        name="东财-分红配送", endpoint="xxx", http_method="GET", enabled=True,
        priority=1, resp_code_field="code", response_parse={}, params={},
    )
    session.add_all([provider, category])
    await session.flush()
    session.add(itf)
    await session.commit()

    cur = today_app_tz().year
    rows = [{
        "代码": "600001", "报告期": f"{cur}-12-31",
        "现金分红-现金分红比例": "1.0", "方案进度": "实施分配",
        "除权除息日": None, "股权登记日": None,
    }]
    svc = DividendSyncService(session)
    changed = await svc._upsert_dividend_batch(itf, rows, cur, 4)
    assert changed == [m.id]  # 回退生效：配 'code' 也能取到 '代码' 列并落库


# ───────────────────────── 未来报告期拦截 / 零落库告警 / 失败冒泡 ─────────────────────────
def test_is_future_period_and_current_quarter():
    """守护：季度结束日晚于今天即未来期次；当前季度换算正确。"""
    assert current_quarter(date(2026, 9, 8)) == (2026, 3)
    assert current_quarter(date(2026, 12, 31)) == (2026, 4)
    # 判据是「严格晚于当前季度」而非晚于结束日：当季（Q3）已有部分披露，不得误伤
    assert is_future_period(2026, 3, date(2026, 9, 8)) is False
    assert is_future_period(2026, 4, date(2026, 9, 8)) is True
    assert is_future_period(2025, 4, date(2026, 9, 8)) is False
    # 已进入 Q4 后，Q4 不再算未来
    assert current_quarter(date(2026, 10, 5)) == (2026, 4)
    assert is_future_period(2026, 4, date(2026, 10, 5)) is False


@pytest.mark.asyncio
async def test_pending_periods_excludes_future_period(session):
    """守护：报告期网格不得含未来期次（东财返 result=null → akshare 抛 NoneType 崩溃）。"""
    svc = DividendSyncService(session)
    out = await svc._pending_periods(date(2026, 9, 8))
    assert (2026, 4) not in out  # 报告期 2026-12-31 尚未到达
    assert (2026, 3) in out      # 当期（09-30）仍须抓取
    assert (2026, 2) in out


@pytest.mark.asyncio
async def test_quarterly_fetch_warns_and_reports_zero_upserted(session, monkeypatch, caplog):
    """守护：抓到行却零落库须告警，且摘要同时报「抓 N / 落 M」（旧版只报抓取行数）。"""
    import logging

    from app.models import InterfaceCategory, QuoteInterface
    from app.models.enums import QuoteProviderAccessMethod
    from app.models.quote_provider import SecuritiesDataProvider
    from app.services.market_data_sync import DIVIDEND_LIST_CAT_ID

    provider = SecuritiesDataProvider(
        id=_uid(), name="东财", access_method=QuoteProviderAccessMethod.SDK,
        config={}, enabled=True,
    )
    category = InterfaceCategory(id=DIVIDEND_LIST_CAT_ID, label="分红配送", system=True)
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=DIVIDEND_LIST_CAT_ID,
        name="东财-分红配送", endpoint="xxx", http_method="GET", enabled=True,
        priority=1, resp_code_field="代码", response_parse={}, params={},
    )
    session.add_all([provider, category])
    await session.flush()
    session.add(itf)
    await session.commit()

    svc = DividendSyncService(session)

    class _Cfg:
        dividend_report_source_interface_id = itf.id

    async def fake_settings():
        return _Cfg()

    async def fake_resolve(_settings, _iid, _cid):
        return itf

    async def fake_periods(_today):
        return [(2020, 1)]

    async def fake_fetch(_itf, _y, _q):
        # 代码 600999 库内无对应 master → 全部跳行，落库 0 条
        return [{"代码": "600999", "现金分红-现金分红比例": "1.0", "方案进度": "实施分配"}]

    async def no_masters(_itf, _rows):
        return 0  # 不建主数据：模拟「代码无法匹配既有证券」

    monkeypatch.setattr(svc._mds, "_upsert_masters", no_masters)
    monkeypatch.setattr(svc, "_settings", fake_settings)
    monkeypatch.setattr(svc, "_resolve_interface", fake_resolve)
    monkeypatch.setattr(svc, "_pending_periods", fake_periods)
    monkeypatch.setattr(svc, "_fetch_period", fake_fetch)

    with caplog.at_level(logging.WARNING, logger="app.services.dividend_sync"):
        result = await svc.quarterly_fetch({}, force=True)
    assert "抓1/落0" in result
    assert any("落库 0 条" in rec.message for rec in caplog.records)


@pytest.mark.asyncio
async def test_quarterly_fetch_raises_when_any_period_failed(session, monkeypatch):
    """守护：任一报告期失败须冒泡为异常（旧版吞进 message，日志仍记 SUCCESS 误导排障）。"""
    from app.models import InterfaceCategory, QuoteInterface
    from app.models.enums import QuoteProviderAccessMethod
    from app.models.quote_provider import SecuritiesDataProvider
    from app.services.market_data_sync import DIVIDEND_LIST_CAT_ID

    provider = SecuritiesDataProvider(
        id=_uid(), name="东财", access_method=QuoteProviderAccessMethod.SDK,
        config={}, enabled=True,
    )
    category = InterfaceCategory(id=DIVIDEND_LIST_CAT_ID, label="分红配送", system=True)
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=DIVIDEND_LIST_CAT_ID,
        name="东财-分红配送", endpoint="xxx", http_method="GET", enabled=True,
        priority=1, resp_code_field="代码", response_parse={}, params={},
    )
    session.add_all([provider, category])
    await session.flush()
    session.add(itf)
    await session.commit()

    svc = DividendSyncService(session)

    class _Cfg:
        dividend_report_source_interface_id = itf.id

    async def fake_settings():
        return _Cfg()

    async def fake_resolve(_settings, _iid, _cid):
        return itf

    async def fake_periods(_today):
        return [(2020, 1)]

    async def boom(_itf, _y, _q):
        raise RuntimeError("'NoneType' object is not subscriptable")

    monkeypatch.setattr(svc, "_settings", fake_settings)
    monkeypatch.setattr(svc, "_resolve_interface", fake_resolve)
    monkeypatch.setattr(svc, "_pending_periods", fake_periods)
    monkeypatch.setattr(svc, "_fetch_period", boom)

    with pytest.raises(RuntimeError, match="季度抓取部分失败"):
        await svc.quarterly_fetch({}, force=True)


# ───────────────────────── P2-4：stale 定责权 / 批量预取消除 N+1 ─────────────────────────
@pytest.mark.asyncio
async def test_refresh_yields_preserves_stale_flag(session):
    """守护 P2-4（§7）：refresh 不重置 stale——stale 唯一定责于 update_stale_flags。

    旧实现无条件 ``stale=False``：日线流程里 ``update_stale_flags`` 先于 refresh 执行，
    stale 刚算出即被抹；06:00 公告扫描路径从不调用 update_stale_flags，被抹后须等
    次日 15:05 才恢复。
    """
    m = await _add_master(session)
    cur = today_app_tz().year
    session.add(_div(m.id, cur, 4, "1.0"))
    session.add(MarketSecurityDailyPrice(
        master_id=m.id, trade_date=date(cur, 9, 1), close=Decimal("10")))
    # 预置 stale=True 快照，模拟「日线任务刚标记 stale → 公告扫描触发重算」
    session.add(SecurityDividendYield(
        master_id=m.id, mode=DividendYieldMode.LFY, stale=True))
    await session.commit()

    await refresh_yields_for_masters(session, [m.id])
    await session.commit()
    snap = (
        await session.execute(
            select(SecurityDividendYield).where(SecurityDividendYield.master_id == m.id)
        )
    ).scalar_one()
    assert snap.stale is True, "refresh 抹掉了 stale（§7 定责权被侵犯）"
    assert snap.dividend_yield == Decimal("0.1")  # 重算本身仍然生效


@pytest.mark.asyncio
async def test_refresh_yields_batch_preload_no_n_plus_1(session, monkeypatch):
    """守护 P2-4：批量预取——查询次数与 master 数量无关（旧实现每证券 3 查 = N+1）。

    断言「3 只证券」与「6 只证券」的 session.execute 调用次数完全相同，
    任一侧退化为逐证券查询即失败。
    """
    cur = today_app_tz().year
    masters = []
    for i in range(6):
        m = await _add_master(session, code=f"sh60010{i}", name=f"批量证券{i}")
        session.add(_div(m.id, cur, 4, "1.0"))
        session.add(MarketSecurityDailyPrice(
            master_id=m.id, trade_date=date(cur, 9, 1), close=Decimal("10")))
        masters.append(m)
    await session.commit()

    orig_execute = session.execute  # 取未被包装的原始绑定方法
    counts: dict[str, int] = {}
    for label, mids in (("3", [m.id for m in masters[:3]]),
                        ("6", [m.id for m in masters])):
        calls = {"n": 0}

        async def _wrapped(*a, _c=calls, **kw):
            _c["n"] += 1
            return await orig_execute(*a, **kw)

        monkeypatch.setattr(session, "execute", _wrapped)
        await refresh_yields_for_masters(session, mids)
        counts[label] = calls["n"]

    assert counts["3"] == counts["6"], (
        f"查询次数随 master 数增长（N+1 回归）：3 只={counts['3']}，6 只={counts['6']}"
    )
    # 批量结构：① 分红 ② 每 master 最大 trade_date ③ 按 (master, date) 取价 ④ 既有快照
    assert counts["3"] == 4, f"批量预取后应仅 4 次查询，实得 {counts['3']}"
