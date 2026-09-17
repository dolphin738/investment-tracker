"""特别分红历史回补单测（§6.9，mock 新浪接口，不触真实网络）。

守护四条硬约束（附录 A.12 实测口径）：
1. **只处理「实施」行**：``进度`` 含「实施」**且** ``除权除息日`` 非空 → 才落 SPECIAL。
   放宽到预案行会把普通分红误判为「东财缺失」而重复写入，导致股息率分子重复计数。
2. **5 年窗口过滤**：``report_year < cutoff_year``（新浪返回全历史）→ 跳过。
3. **西向去重不重复写**：同 ``ex_dividend_date`` 或同 ``(年,季,金额)`` → 跳过。
4. **顺序 fail fast**：无报告期分红行 / 补充源缺失 → raise，不落任何数据。

mock 风格沿用 tests/test_dividend_notice_scan.py（替换 ``svc._mds.call_interface_raw``）。
"""
from __future__ import annotations

import re
import uuid
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.date_utils import today_app_tz
from app.models import (
    DividendYieldSettings,
    InterfaceCategory,
    QuoteInterface,
    SecuritiesDataProvider,
    Security,
    SecurityDividend,
)
from app.models.enums import DividendStatus, ReportPeriodType, SecurityType
from app.services.dividend_notice_scan import (
    _BACKFILL_YEARS,
    _COL_SINA_ANN,
    _COL_SINA_CASH,
    _COL_SINA_EXDATE,
    _COL_SINA_PROGRESS,
    DividendNoticeScanService,
    run_dividend_special_backfill,
)
from app.services.market_data_sync import (
    DIVIDEND_LIST_CAT_ID,
    NOTICE_CAT_ID,
    MarketDataSyncService,
    _normalize_master_code,
    infer_exchange,
)


def _uid() -> str:
    return str(uuid.uuid4())


def _cutoff(today: date) -> int:
    """回补窗口下界（与 ``backfill_specials`` 同式，随 ``_BACKFILL_YEARS`` 联动）。"""
    return today.year - _BACKFILL_YEARS + 1


async def _add_master(session, code="600519", name="贵州茅台", mid=None):
    """建证券主数据；``mid`` 可显式指定主键，用于固定 ``sorted(mids)`` 的处理顺序。"""
    norm = _normalize_master_code(code, infer_exchange(code))
    m = Security(id=mid or _uid(), code=norm, name=name, exchange="SH",
                 asset_class=SecurityType.STOCK)
    session.add(m)
    await session.flush()
    return m


def _report_row(master_id, cash, ry, rq, ex=None, period=ReportPeriodType.ANNUAL):
    """东财报告期行（period_type != SPECIAL）——回补入口的前置数据与西向去重依据。"""
    return SecurityDividend(
        master_id=master_id,
        report_year=ry,
        report_quarter=rq,
        period_type=period,
        cash_per_share=Decimal(cash),
        status=DividendStatus.PAID,
        ex_dividend_date=ex,
        source="东财-分红配送",
    )


def _special_row(master_id, cash, ry, rq, ex=None, ann=None, status=DividendStatus.PAID):
    return SecurityDividend(
        master_id=master_id,
        report_year=ry,
        report_quarter=rq,
        period_type=ReportPeriodType.SPECIAL,
        cash_per_share=Decimal(cash),
        status=status,
        ex_dividend_date=ex,
        announcement_date=ann,
        source="公告扫描",
    )


def _sina_row(ann, cash, progress, ex):
    """构造一行新浪历史分红明细（列名取模块常量，勿写死字面量）。"""
    return {
        _COL_SINA_ANN: ann,
        _COL_SINA_CASH: cash,
        _COL_SINA_PROGRESS: progress,
        _COL_SINA_EXDATE: ex,
    }


async def _seed_detail(session, *, enabled=True, provider_enabled=True,
                       name="新浪历史分红明细", with_settings=True):
    """分类 3「股息列表」补充源接口 + 全局配置指向它；返回接口行。"""
    if await session.get(InterfaceCategory, DIVIDEND_LIST_CAT_ID) is None:
        session.add(InterfaceCategory(id=DIVIDEND_LIST_CAT_ID, label="分红配送", system=True))
    provider = SecuritiesDataProvider(
        id=_uid(), name="sina", access_method="sdk", config={}, enabled=provider_enabled,
    )
    session.add(provider)
    await session.flush()
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=DIVIDEND_LIST_CAT_ID,
        name=name, endpoint="stock_history_dividend_detail", enabled=enabled,
        priority=1, params={},
    )
    session.add(itf)
    await session.flush()
    if with_settings:
        session.add(DividendYieldSettings(
            id=_uid(), dividend_detail_source_interface_id=itf.id,
        ))
    await session.commit()
    return itf


async def _seed_notice(session, *, enabled=True, provider_enabled=True,
                       name="沪深京A股公告"):
    """分类 4「公司公告」接口，并把既有配置行的公告源指向它；返回接口行。

    须在 ``_seed_detail`` 之后调用（复用其创建的配置行）。
    """
    if await session.get(InterfaceCategory, NOTICE_CAT_ID) is None:
        session.add(InterfaceCategory(id=NOTICE_CAT_ID, label="公司公告", system=True))
    provider = SecuritiesDataProvider(
        id=_uid(), name="akshare", access_method="sdk", config={}, enabled=provider_enabled,
    )
    session.add(provider)
    await session.flush()
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=NOTICE_CAT_ID,
        name=name, endpoint="stock_notice_report", enabled=enabled,
        priority=1, params={"symbol": "财务报告"}, resp_code_field="代码",
    )
    session.add(itf)
    await session.flush()
    settings = (
        await session.execute(select(DividendYieldSettings).limit(1))
    ).scalar_one_or_none()
    if settings is not None:
        settings.announcement_source_interface_id = itf.id
    await session.commit()
    return itf


async def _prepare(session, *, code="600519", name="贵州茅台",
                   report=("1.0", None, None, None)):
    """标准前置：master + 报告期行 + 补充源配置。

    ``report`` = (cash, ry, rq, ex)；ry/rq 为 None 时默认 (cur-1, 4)。
    返回 (master, detail_itf)。
    """
    m = await _add_master(session, code=code, name=name)
    cash, ry, rq, ex = report
    cur = today_app_tz().year
    session.add(_report_row(m.id, cash, ry if ry is not None else cur - 1,
                            rq if rq is not None else 4, ex=ex))
    itf = await _seed_detail(session)
    return m, itf


def _install_sina(svc, rows_by_symbol, calls=None, errors=None):
    """替换 ``call_interface_raw``：按 params.symbol 返回预置行（逐只形态）。"""
    async def _fake(itf, params, codes):
        sym = (params or {}).get("symbol")
        if calls is not None:
            calls.append({"symbol": sym, "codes": codes})
        if errors and sym in errors:
            raise errors[sym]
        return list(rows_by_symbol.get(sym, []))

    svc._mds.call_interface_raw = _fake


def _install_scan_sources(svc, notice_rows, sina_by_symbol, errors=None):
    """``scan()`` 的双源 mock：分类 4 接口返回公告行，补充源按 symbol 返回新浪明细。"""
    async def _fake(itf, params, codes):
        if itf.category_id == NOTICE_CAT_ID:
            return list(notice_rows)
        sym = (params or {}).get("symbol")
        if errors and sym in errors:
            raise errors[sym]
        return list(sina_by_symbol.get(sym, []))

    svc._mds.call_interface_raw = _fake


def _new_stats() -> dict:
    return {"new": 0, "dup": 0, "window": 0, "nocash": 0, "anchor": 0, "failed": 0}


async def _run_one(svc, master, today, rows, *, stats=None, calls=None, errors=None):
    """跑一次 ``_backfill_one``（自带补充源解析），返回 (dirty, stats)。"""
    _install_sina(svc, {_digits(master.code): rows}, calls=calls, errors=errors)
    stats = stats if stats is not None else _new_stats()
    detail = await svc._resolve_detail_itf(await svc._settings())
    dirty = await svc._backfill_one(master.id, master.code, detail, today, _cutoff(today), stats)
    return dirty, stats


def _digits(code: str) -> str:
    """主数据代码 → 纯数字代码（新浪逐只入参形态）。"""
    return re.sub(r"\D", "", code)


async def _specials(session, master_id):
    return (
        await session.execute(
            select(SecurityDividend).where(
                SecurityDividend.master_id == master_id,
                SecurityDividend.period_type == ReportPeriodType.SPECIAL,
            )
        )
    ).scalars().all()


async def _all_dividends(session, master_id):
    return (
        await session.execute(
            select(SecurityDividend).where(SecurityDividend.master_id == master_id)
        )
    ).scalars().all()


# ───────────────────────── 窗口常量（§6.9 / §6.3 留存窗口对齐） ─────────────────────────
def test_backfill_years_window_constant_is_five():
    """守护 §6.9：回补窗口常量 = 5 个财年，与 §6.3 留存窗口一致（改动须同步决策）。"""
    assert _BACKFILL_YEARS == 5


# ───────────────────── 约束 1：只处理「实施」行（附录 A.12 命门） ─────────────────────
@pytest.mark.asyncio
async def test_backfill_one_writes_paid_special_from_impl_row(session):
    """正向：进度=实施 + 除权日非空 → 写 PAID SPECIAL（公告日期锚点落格，金额 ÷10）。"""
    m, _ = await _prepare(session)
    cur = today_app_tz().year
    svc = DividendNoticeScanService(session)
    today = today_app_tz()

    dirty, stats = await _run_one(svc, m, today, [
        _sina_row(f"{cur - 1}-06-10", "50", "实施", f"{cur - 1}-06-20"),
    ])
    await session.commit()

    assert dirty is True
    assert stats["new"] == 1 and stats["dup"] == 0 and stats["window"] == 0
    rows = await _specials(session, m.id)
    assert len(rows) == 1
    row = rows[0]
    assert row.status == DividendStatus.PAID
    assert (row.report_year, row.report_quarter) == (cur - 1, 2)  # 6 月 → Q2
    assert row.cash_per_share == Decimal("5.0")                   # 每 10 股 50 元 → 每股 5.0
    assert row.ex_dividend_date == date(cur - 1, 6, 20)
    assert row.announcement_date == date(cur - 1, 6, 10)


@pytest.mark.asyncio
async def test_backfill_one_skips_proposed_row(session):
    """约束 1 反向：进度=预案 + 除权日为空 → 绝不写 SPECIAL（否则分子重复计数）。

    若实现放宽到预案行，本例的每股 5.0 元普通分红会被误判为「东财缺失」落 SPECIAL。
    """
    m, _ = await _prepare(session)
    cur = today_app_tz().year
    svc = DividendNoticeScanService(session)
    today = today_app_tz()

    dirty, stats = await _run_one(svc, m, today, [
        _sina_row(f"{cur - 1}-06-10", "50", "预案", ""),
    ])
    await session.commit()

    assert dirty is False
    assert stats["new"] == 0
    assert await _specials(session, m.id) == []
    # 未污染：仍只有前置的报告期行
    assert len(await _all_dividends(session, m.id)) == 1


@pytest.mark.asyncio
async def test_backfill_one_skips_impl_row_without_ex_date(session):
    """约束 1 反向（另一分支）：进度含「实施」但除权日为空 → 跳过（ex_date 是去重前提）。"""
    m, _ = await _prepare(session)
    cur = today_app_tz().year
    svc = DividendNoticeScanService(session)
    today = today_app_tz()

    dirty, stats = await _run_one(svc, m, today, [
        _sina_row(f"{cur - 1}-06-10", "50", "实施", ""),    # 实施但无除权日
        _sina_row(f"{cur - 1}-03-10", "30", "实施", None),  # 实施但除权日为 None
    ])
    await session.commit()

    assert dirty is False
    assert stats["new"] == 0
    assert await _specials(session, m.id) == []


# ───────────────────────── 约束 2：5 年窗口过滤（含边界） ─────────────────────────
@pytest.mark.asyncio
async def test_backfill_one_window_filter_with_boundary(session):
    """约束 2：``report_year < cutoff`` 计入 window 跳过；``== cutoff`` 保留（边界含入）。"""
    m, _ = await _prepare(session)
    cur = today_app_tz().year
    svc = DividendNoticeScanService(session)
    today = today_app_tz()
    cutoff = _cutoff(today)

    _, stats = await _run_one(svc, m, today, [
        _sina_row(f"{cur - 6}-05-10", "50", "实施", f"{cur - 6}-05-20"),  # 窗口外
        _sina_row(f"{cutoff}-01-05", "60", "实施", f"{cutoff}-01-15"),    # 边界 == cutoff，保留
    ])
    await session.commit()

    assert stats["window"] == 1
    assert stats["new"] == 1
    rows = await _specials(session, m.id)
    assert len(rows) == 1
    assert (rows[0].report_year, rows[0].report_quarter) == (cutoff, 1)
    assert rows[0].cash_per_share == Decimal("6.0")


# ───────────────────────── 约束 3：西向去重不重复写 ─────────────────────────
@pytest.mark.asyncio
async def test_backfill_one_westward_dup_by_ex_date(session):
    """约束 3a：已有报告期行「ex_dividend_date 相等」→ 计入 dup，不写 SPECIAL。"""
    cur = today_app_tz().year
    m, _ = await _prepare(session, report=("1.0", cur - 1, 4, date(cur - 1, 6, 20)))
    svc = DividendNoticeScanService(session)
    today = today_app_tz()

    dirty, stats = await _run_one(svc, m, today, [
        _sina_row(f"{cur - 1}-06-10", "50", "实施", f"{cur - 1}-06-20"),  # 同除权日
    ])
    await session.commit()

    assert dirty is False
    assert stats["dup"] == 1
    assert stats["new"] == 0
    assert await _specials(session, m.id) == []


@pytest.mark.asyncio
async def test_backfill_one_westward_dup_by_year_quarter_cash(session):
    """约束 3b：同 ``(report_year, report_quarter, cash)`` 全等 → dup 跳过（除权日可不同）。"""
    cur = today_app_tz().year
    # 报告期行落在 SPECIAL 将落的同格且同额（除权日不同）
    m, _ = await _prepare(session, report=("5.0", cur - 1, 2, None))
    svc = DividendNoticeScanService(session)
    today = today_app_tz()

    dirty, stats = await _run_one(svc, m, today, [
        _sina_row(f"{cur - 1}-06-10", "50", "实施", f"{cur - 1}-06-20"),  # → (cur-1, Q2, 5.0)
    ])
    await session.commit()

    assert dirty is False
    assert stats["dup"] == 1
    assert stats["new"] == 0
    assert await _specials(session, m.id) == []


@pytest.mark.asyncio
async def test_backfill_one_skips_when_anchor_cell_has_special(session):
    """同格「已有 SPECIAL 行但不同额」→ 跳过（防唯一键冲突，不覆写既有 SPECIAL）。"""
    cur = today_app_tz().year
    m, _ = await _prepare(session)
    session.add(_special_row(m.id, "9.9", cur - 1, 2,
                             ex=date(cur - 1, 3, 1), ann=date(cur - 1, 2, 20)))
    await session.commit()

    svc = DividendNoticeScanService(session)
    today = today_app_tz()
    dirty, stats = await _run_one(svc, m, today, [
        _sina_row(f"{cur - 1}-06-10", "50", "实施", f"{cur - 1}-06-20"),  # 同格不同额
    ])
    await session.commit()

    assert dirty is False
    assert stats["new"] == 0
    assert stats["anchor"] == 1  # L-2：同格已有 SPECIAL 计入 anchor 跳过（运维对账可见）
    rows = await _specials(session, m.id)
    assert len(rows) == 1
    assert rows[0].cash_per_share == Decimal("9.9")  # 既有行未被覆写/未被冲掉


# ───────────────────────── 无金额行 ─────────────────────────
@pytest.mark.asyncio
async def test_backfill_one_counts_nocash_row(session):
    """派息为空/占位符 → 计入 nocash 并跳过（不落无效金额污染分子）。"""
    m, _ = await _prepare(session)
    cur = today_app_tz().year
    svc = DividendNoticeScanService(session)
    today = today_app_tz()

    _, stats = await _run_one(svc, m, today, [
        _sina_row(f"{cur - 1}-06-10", "-", "实施", f"{cur - 1}-06-20"),
        _sina_row(f"{cur - 1}-07-10", "", "实施", f"{cur - 1}-07-20"),
    ])
    await session.commit()

    assert stats["nocash"] == 2
    assert stats["new"] == 0
    assert await _specials(session, m.id) == []


# ───────────────────────── 幂等 ─────────────────────────
@pytest.mark.asyncio
async def test_backfill_one_idempotent_on_second_run(session):
    """幂等：同一只连续两次回补，第二次 new=0（去重命中），SPECIAL 表仍只有一行。"""
    m, _ = await _prepare(session)
    cur = today_app_tz().year
    svc = DividendNoticeScanService(session)
    today = today_app_tz()
    rows = [_sina_row(f"{cur - 1}-06-10", "50", "实施", f"{cur - 1}-06-20")]

    first_dirty, first = await _run_one(svc, m, today, rows)
    await session.commit()
    assert first_dirty is True
    assert first["new"] == 1

    second_dirty, second = await _run_one(svc, m, today, rows)
    await session.commit()
    assert second_dirty is False
    assert second["new"] == 0
    assert second["dup"] == 1
    assert len(await _specials(session, m.id)) == 1


# ───────────────────────── 逐只调用契约（symbol 纯数字） ─────────────────────────
@pytest.mark.asyncio
async def test_backfill_one_calls_interface_per_symbol_with_digits(session):
    """守护调用契约：逐只（codes=None）+ ``symbol`` 为**纯数字代码**（剥离 sh/sz 前缀）。"""
    m, _ = await _prepare(session)
    assert m.code == "sh600519"
    svc = DividendNoticeScanService(session)

    calls: list[dict] = []
    await _run_one(svc, m, today_app_tz(), [], calls=calls)

    assert len(calls) == 1
    assert calls[0]["symbol"] == "600519"   # 纯数字，非 "sh600519"
    assert calls[0]["codes"] is None        # 逐只形态，非批量 codes


# ───────────────────────── 约束 4：顺序 fail fast ─────────────────────────
@pytest.mark.asyncio
async def test_backfill_specials_raises_without_report_period_rows(session):
    """约束 4：无任何分红行 → raise 且**不写任何数据**（否则普通分红被误判东财缺失）。"""
    await _add_master(session)
    await _seed_detail(session)
    svc = DividendNoticeScanService(session)
    _install_sina(svc, {"600519": [_sina_row("2025-06-10", "50", "实施", "2025-06-20")]})

    with pytest.raises(RuntimeError, match="季度股息抓取"):
        await svc.backfill_specials(None)
    await session.rollback()
    assert (await session.execute(select(SecurityDividend))).scalars().all() == []


@pytest.mark.asyncio
async def test_backfill_specials_raises_when_only_special_rows(session):
    """约束 4 变体：只有 SPECIAL 行（无报告期行）同样 raise —— 西向去重前提不成立。"""
    m = await _add_master(session)
    mid = m.id  # rollback 会 expire 实例，先固化主键
    cur = today_app_tz().year
    session.add(_special_row(mid, "5.0", cur - 1, 2, ex=date(cur - 1, 6, 20)))
    await _seed_detail(session)
    svc = DividendNoticeScanService(session)
    _install_sina(svc, {"600519": [
        _sina_row(f"{cur - 1}-06-10", "50", "实施", f"{cur - 1}-06-20"),
    ]})

    with pytest.raises(RuntimeError, match="季度股息抓取"):
        await svc.backfill_specials(None)
    await session.rollback()
    assert len(await _specials(session, mid)) == 1  # 既有行未被新增


@pytest.mark.asyncio
async def test_backfill_specials_raises_when_detail_source_missing(session):
    """补充源（新浪历史分红明细）未配置 → fail fast raise，不逐只调用。"""
    m = await _add_master(session)
    mid = m.id  # rollback 会 expire 实例，先固化主键
    cur = today_app_tz().year
    session.add(_report_row(mid, "1.0", cur - 1, 4))
    session.add(DividendYieldSettings(
        id=_uid(), 
    ))  # 未配置 dividend_detail_source_interface_id
    await session.commit()

    svc = DividendNoticeScanService(session)
    calls: list[dict] = []
    _install_sina(svc, {"600519": [
        _sina_row(f"{cur - 1}-06-10", "50", "实施", f"{cur - 1}-06-20"),
    ]}, calls=calls)

    with pytest.raises(RuntimeError, match="补充源"):
        await svc.backfill_specials(None)
    await session.rollback()
    assert calls == []                        # fail fast：一行都没调
    assert await _specials(session, mid) == []


# ───────────────────────── 批量入口：摘要 / 单只失败不中断 ─────────────────────────
@pytest.mark.asyncio
async def test_backfill_specials_end_to_end_summary(session):
    """集成：实施行落库 / 预案行跳过 / 窗口外过滤 / 无金额计数，摘要与数据一致。"""
    m, _ = await _prepare(session)
    cur = today_app_tz().year
    today = today_app_tz()
    svc = DividendNoticeScanService(session)
    _install_sina(svc, {"600519": [
        _sina_row(f"{cur - 1}-06-10", "50", "实施", f"{cur - 1}-06-20"),   # 落库
        _sina_row(f"{cur - 1}-05-10", "40", "预案", ""),                   # 跳过（预案）
        _sina_row(f"{_cutoff(today) - 2}-05-10", "30", "实施",
                  f"{_cutoff(today) - 2}-05-20"),                          # 窗口外
        _sina_row(f"{cur - 1}-04-10", "-", "实施", f"{cur - 1}-04-20"),    # 无金额
    ]})
    summary = await svc.backfill_specials(None)

    assert "证券1只" in summary
    assert "新写1" in summary and "窗口外1" in summary and "无金额1" in summary
    assert "失败0只" in summary
    assert "重算1只" in summary
    rows = await _specials(session, m.id)
    assert len(rows) == 1
    assert rows[0].cash_per_share == Decimal("5.0")
    assert rows[0].status == DividendStatus.PAID


@pytest.mark.asyncio
async def test_backfill_specials_continues_after_single_master_failure(session):
    """单证券异常 → rollback 续下一只（断点即数据本身），失败计入摘要、已落库数据保留。

    主键显式指定为 ``...0001/0002``，固定 ``sorted(mids)`` 顺序：正常证券先跑并提交，
    异常证券随后失败，排除顺序抖动导致的假绿/假红。
    """
    cur = today_app_tz().year
    ok = await _add_master(session, code="600519", name="正常证券",
                           mid="00000000-0000-0000-0000-000000000001")
    bad = await _add_master(session, code="000001", name="异常证券",
                            mid="00000000-0000-0000-0000-000000000002")
    session.add(_report_row(ok.id, "1.0", cur - 1, 4))
    session.add(_report_row(bad.id, "2.0", cur - 1, 4))
    await _seed_detail(session)
    ok_id, bad_id = ok.id, bad.id  # rollback 可能 expire 实例，先固化主键

    svc = DividendNoticeScanService(session)
    _install_sina(
        svc,
        {
            "600519": [_sina_row(f"{cur - 1}-06-10", "50", "实施", f"{cur - 1}-06-20")],
            "000001": [_sina_row(f"{cur - 1}-06-10", "80", "实施", f"{cur - 1}-06-20")],
        },
        errors={"000001": RuntimeError("新浪接口 500")},
    )
    summary = await svc.backfill_specials(None)

    assert "证券2只" in summary
    assert "失败1只" in summary
    assert "新写1" in summary
    assert len(await _specials(session, ok_id)) == 1  # 先提交的变更不被后续 rollback 抹掉
    assert await _specials(session, bad_id) == []


@pytest.mark.asyncio
async def test_backfill_specials_recovers_for_master_after_a_failed_one(session):
    """**失败在前**时，其后的正常证券仍必须能继续回补（原缺陷取证，已修复）。

    ``rollback()`` 在有活动事务时会 expire 会话内全部 ORM 实例；若不在失败路径重新解析
    补充源，下一只再读 ``detail.params`` 会触发同步惰性加载 → MissingGreenlet → 被
    ``except Exception`` 吞成「失败」，其后每一只连锁失败（修复前：新写0；失败2只）。
    """
    cur = today_app_tz().year
    bad = await _add_master(session, code="000001", name="异常证券",
                            mid="00000000-0000-0000-0000-000000000001")
    ok = await _add_master(session, code="600519", name="正常证券",
                           mid="00000000-0000-0000-0000-000000000002")
    session.add(_report_row(bad.id, "2.0", cur - 1, 4))
    session.add(_report_row(ok.id, "1.0", cur - 1, 4))
    await _seed_detail(session)
    ok_id, bad_id = ok.id, bad.id  # rollback 可能 expire 实例，先固化主键

    svc = DividendNoticeScanService(session)
    _install_sina(
        svc,
        {
            "600519": [_sina_row(f"{cur - 1}-06-10", "50", "实施", f"{cur - 1}-06-20")],
            "000001": [_sina_row(f"{cur - 1}-06-10", "80", "实施", f"{cur - 1}-06-20")],
        },
        errors={"000001": RuntimeError("新浪接口 500")},
    )
    summary = await svc.backfill_specials(None)

    assert "新写1" in summary
    assert "失败1只" in summary
    assert len(await _specials(session, ok_id)) == 1
    assert await _specials(session, bad_id) == []


@pytest.mark.asyncio
async def test_backfill_specials_reresolves_detail_after_real_rollback(session):
    """**真实 rollback** 场景：失败发生在写入之后（事务内有待提交 INSERT）。

    此时 ``rollback()`` 不是空操作，会 expire 会话内全部实例 → ``detail`` 过期 →
    若不在失败路径重新解析，下一只读 ``detail.params`` 触发 MissingGreenlet 连锁失败。
    本例是「失败后必须重解析补充源」这条修复的**直接**守护（上一条用例的异常发生在
    任何 SQL 之前，其 rollback 为空操作，覆盖不到本路径）。
    """
    cur = today_app_tz().year
    bad = await _add_master(session, code="000001", name="异常证券",
                            mid="00000000-0000-0000-0000-000000000001")
    ok = await _add_master(session, code="600519", name="正常证券",
                           mid="00000000-0000-0000-0000-000000000002")
    session.add(_report_row(bad.id, "2.0", cur - 1, 4))
    session.add(_report_row(ok.id, "1.0", cur - 1, 4))
    await _seed_detail(session)
    ok_id, bad_id = ok.id, bad.id

    svc = DividendNoticeScanService(session)
    _install_sina(svc, {
        "600519": [_sina_row(f"{cur - 1}-06-10", "50", "实施", f"{cur - 1}-06-20")],
        "000001": [_sina_row(f"{cur - 1}-06-10", "80", "实施", f"{cur - 1}-06-20")],
    })

    real_one = svc._backfill_one

    async def _write_then_crash(mid, code, detail, today, cutoff, stats):
        """异常证券：先真实走完回补（产生活动事务 + 待提交 INSERT）再抛错。"""
        result = await real_one(mid, code, detail, today, cutoff, stats)
        if mid == bad_id:
            raise RuntimeError("写库后崩溃（模拟提交前异常）")
        return result

    svc._backfill_one = _write_then_crash
    summary = await svc.backfill_specials(None)

    # 断言以**落库结果**为准：stats["new"] 是累计计数，被 rollback 的那只也已 +1，
    # 故摘要「新写」会偏大（见回报中的备注），不据此断言。
    assert "失败1只" in summary
    assert len(await _specials(session, ok_id)) == 1   # 后续证券未被连锁打成失败
    assert await _specials(session, bad_id) == []      # 异常证券写入被 rollback 丢弃


@pytest.mark.asyncio
async def test_backfill_specials_fails_fast_when_source_disabled_mid_run(session):
    """补充源在回补过程中被停用 → fail fast raise，而非把「源失效」伪装成逐只失败。

    模拟方式：``_resolve_detail_itf`` 首次（循环前）返回真实接口，之后返回 ``None``
    （等价接口被停用/删除或提供方被停用）。期望在第一只失败后的重解析处终止。
    """
    cur = today_app_tz().year
    bad = await _add_master(session, code="000001", name="异常证券",
                            mid="00000000-0000-0000-0000-000000000001")
    ok = await _add_master(session, code="600519", name="正常证券",
                           mid="00000000-0000-0000-0000-000000000002")
    session.add(_report_row(bad.id, "2.0", cur - 1, 4))
    session.add(_report_row(ok.id, "1.0", cur - 1, 4))
    await _seed_detail(session)
    ok_id = ok.id

    svc = DividendNoticeScanService(session)
    _install_sina(
        svc,
        {
            "600519": [_sina_row(f"{cur - 1}-06-10", "50", "实施", f"{cur - 1}-06-20")],
            "000001": [_sina_row(f"{cur - 1}-06-10", "80", "实施", f"{cur - 1}-06-20")],
        },
        errors={"000001": RuntimeError("新浪接口 500")},
    )
    real_resolve = svc._resolve_detail_itf
    calls = {"n": 0}

    async def _resolve_then_vanish(settings):
        calls["n"] += 1
        if calls["n"] == 1:
            return await real_resolve(settings)
        return None

    svc._resolve_detail_itf = _resolve_then_vanish

    with pytest.raises(RuntimeError, match="变为不可用"):
        await svc.backfill_specials(None)
    await session.rollback()

    assert calls["n"] == 2            # 循环前 1 次 + 首只失败后重解析 1 次
    assert await _specials(session, ok_id) == []  # 未继续把剩余证券逐只打成失败


@pytest.mark.asyncio
async def test_backfill_specials_continues_when_reresolve_raises_transient(session):
    """L-3：首只失败重解析补充源时**过程异常**（非「源失效」）→ 不终止整轮，按失败续下一只。

    模拟 DB 瞬时抖动：``_resolve_detail_itf`` 首次（循环前）成功，首只失败后的重解析抛
    ``RuntimeError("…瞬时抖动…")``（过程异常，不含「变为不可用」），其后重解析恢复 →
    后续证券仍须继续回补（已提交部分保留）。
    """
    cur = today_app_tz().year
    bad = await _add_master(session, code="000001", name="异常证券",
                            mid="00000000-0000-0000-0000-000000000001")
    ok1 = await _add_master(session, code="600519", name="正常证券1",
                            mid="00000000-0000-0000-0000-000000000002")
    ok2 = await _add_master(session, code="000002", name="正常证券2",
                            mid="00000000-0000-0000-0000-000000000003")
    session.add(_report_row(bad.id, "2.0", cur - 1, 4))
    session.add(_report_row(ok1.id, "1.0", cur - 1, 4))
    session.add(_report_row(ok2.id, "3.0", cur - 1, 4))
    await _seed_detail(session)
    bad_id, ok1_id, ok2_id = bad.id, ok1.id, ok2.id

    svc = DividendNoticeScanService(session)
    _install_sina(
        svc,
        {
            "000001": [_sina_row(f"{cur - 1}-06-10", "80", "实施", f"{cur - 1}-06-20")],
            "600519": [_sina_row(f"{cur - 1}-06-10", "50", "实施", f"{cur - 1}-06-20")],
            "000002": [_sina_row(f"{cur - 1}-06-10", "30", "实施", f"{cur - 1}-06-20")],
        },
        errors={"000001": RuntimeError("新浪接口 500")},
    )
    real_resolve = svc._resolve_detail_itf
    calls = {"n": 0}

    async def _resolve_then_transient_then_ok(settings):
        calls["n"] += 1
        if calls["n"] == 2:
            # 首只失败后的重解析：模拟 DB 瞬时抖动（过程异常，非「源失效」）
            raise RuntimeError("DB 连接瞬时抖动（过程异常）")
        return await real_resolve(settings)

    svc._resolve_detail_itf = _resolve_then_transient_then_ok

    # 不终止整轮：过程异常被吞，按失败续下一只
    summary = await svc.backfill_specials(None)
    await session.rollback()

    assert "失败1只" in summary            # 仅异常证券失败
    assert "新写2" in summary             # 后续证券在重解析恢复后继续写入
    assert await _specials(session, bad_id) == []
    assert len(await _specials(session, ok1_id)) == 1
    assert len(await _specials(session, ok2_id)) == 1


# ───────────────────────── scan() 同构容错（§6.8 与 §6.9 同一模式） ─────────────────────────
@pytest.mark.asyncio
async def test_scan_recovers_for_master_after_a_failed_one(session):
    """``scan()`` 与回补同构：循环外解析 detail、except 里 rollback → 同一连锁失败风险。

    构造「失败在前」：异常证券(0001)在 ``_process_master`` 抛错触发**真实** rollback
    （``scan()`` 循环前无 commit，前置查询仍占着事务，故该 rollback 会 expire 全部实例），
    其后的正常证券(0002)仍须正常写入。
    """
    cur = today_app_tz().year
    bad = await _add_master(session, code="000001", name="异常证券",
                            mid="00000000-0000-0000-0000-000000000001")
    ok = await _add_master(session, code="600519", name="正常证券",
                           mid="00000000-0000-0000-0000-000000000002")
    await _seed_detail(session)
    await _seed_notice(session)
    ok_id, bad_id = ok.id, bad.id  # rollback 会 expire 调用方持有的实例，先固化主键

    svc = DividendNoticeScanService(session)
    notice_rows = [
        {"代码": "000001", "公告标题": "异常证券2022年度回报股东特别分红实施公告"},
        {"代码": "600519", "公告标题": "正常证券2022年度回报股东特别分红实施公告"},
    ]
    _install_scan_sources(
        svc,
        notice_rows,
        {"600519": [_sina_row(f"{cur - 1}-06-10", "50", "实施", f"{cur - 1}-06-20")]},
        errors={"000001": RuntimeError("新浪接口 500")},
    )
    summary = await svc.scan(None)

    assert "命中2" in summary          # 两只均被公告标题二筛命中
    assert "失败1只" in summary        # 仅异常证券失败
    assert "新写1" in summary          # 正常证券仍写入
    assert len(await _specials(session, ok_id)) == 1
    assert await _specials(session, bad_id) == []


@pytest.mark.asyncio
async def test_scan_counts_anchor_skip_in_summary(session):
    """scan 同格已有 SPECIAL 行 → 计入 anchor 跳过并纳入摘要（L-2）。"""
    cur = today_app_tz().year
    m, _ = await _prepare(session)
    # 预置同格 SPECIAL（与回补将落格相同），使 _exists_anchor 命中
    session.add(_special_row(m.id, "9.9", cur - 1, 2,
                             ex=date(cur - 1, 3, 1), ann=date(cur - 1, 2, 20)))
    await session.commit()
    await _seed_notice(session)
    svc = DividendNoticeScanService(session)
    notice_rows = [
        {"代码": "600519", "公告标题": "正常证券2022年度回报股东特别分红实施公告"},
    ]
    _install_scan_sources(svc, notice_rows, {
        "600519": [_sina_row(f"{cur - 1}-06-10", "50", "实施", f"{cur - 1}-06-20")],
    })
    summary = await svc.scan(None)

    assert "锚点跳过1" in summary
    assert "新写0" in summary  # 未重复写
    # 未重复写：仍只有预置的那 1 行 SPECIAL
    assert len(await _specials(session, m.id)) == 1


# ───────────────────────── 模块级 handler 接线（§6.9 系统任务） ─────────────────────────
@pytest.mark.asyncio
async def test_run_dividend_special_backfill_handler_wires_service(session, monkeypatch):
    """守护 handler 接线：自带 session 调 ``backfill_specials`` 并落库（任务注册依赖）。"""
    m, _ = await _prepare(session)
    mid = m.id
    cur = today_app_tz().year

    async def _fake(self, itf, params, codes):
        return [_sina_row(f"{cur - 1}-06-10", "50", "实施", f"{cur - 1}-06-20")]

    monkeypatch.setattr(MarketDataSyncService, "call_interface_raw", _fake)
    summary = await run_dividend_special_backfill(None)

    assert "特别分红历史回补完成" in summary
    assert "新写1" in summary
    # handler 自带 session 提交；此处新查询（READ COMMITTED）可见其落库结果
    rows = await _specials(session, mid)
    assert len(rows) == 1
    assert rows[0].cash_per_share == Decimal("5.0")
    assert rows[0].status == DividendStatus.PAID
