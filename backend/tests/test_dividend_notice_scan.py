"""公告扫描 + 巨潮历史分红采集服务单测（mock 网络层，不触真实巨潮/东财）。

守护方案 §5「分红采集链路迁移」：
- §5.2 调用编排：``symbol`` = 证券代码纯数字、遍历**全部返回行**；
- §5.3 字段映射：巨潮 11 列 → 目标列（每 10 股 ÷10 折算为每股）；
- §5.4 两处语义缺口：报告期解析取代公告日锚点；除权日非空 → PAID，否则 PROPOSED；
- §5.5 标题二筛放宽：候选 = 命中分红正则 ∧ 非 cancel（普通年度分红公告亦命中）；
- §5.6 幂等去重：唯一键定位后更新（同格同额但日期变化的行**必须**被刷新）。

旧新浪口径（``_anchor`` / ``_sina_cash`` / ``_COL_SINA_*`` / ``_new_special`` /
``_process_master``）已随链路迁移删除，相关用例改为按新链路驱动。
"""
from __future__ import annotations

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
    SecurityDividendPending,
)
from app.models.enums import DividendStatus, ReportPeriodType, SecurityType
from app.services.dividend_cninfo_parse import (
    COL_ANN,
    COL_ARRIVE,
    COL_BONUS,
    COL_CASH,
    COL_CONVERT,
    COL_DESC,
    COL_EX,
    COL_PAY,
    COL_PERIOD_TYPE,
    COL_RECORD,
    COL_REPORT,
    parse_period_type,
    retention_cutoff_year,
)
from app.services.dividend_notice_meta import (
    _TITLE_CANCEL_RE,
    _TITLE_DIVIDEND_RE,
)
from app.services.dividend_notice_scan import (
    DividendNoticeScanService,
)
from app.services.market_data_sync import (
    DIVIDEND_LIST_CAT_ID,
    NOTICE_CAT_ID,
    MarketDataSyncService,
    infer_exchange,
    _normalize_master_code,
)


def _uid() -> str:
    return str(uuid.uuid4())


def _cur_year() -> int:
    return today_app_tz().year


def _new_stats() -> dict:
    """与 ``scan()`` / ``seed()`` 同键集的计数器（``fetch_and_upsert_master`` 只写其中若干键）。"""
    return {
        "rows": 0, "hits": 0, "new": 0, "upd": 0, "anchor": 0,
        "skip": 0, "no_period": 0, "unknown_label": 0, "collision": 0,
        "window": 0, "skipped": 0, "staged": 0,
    }


async def _add_master(session, code="600519", name="贵州茅台"):
    norm = _normalize_master_code(code, infer_exchange(code))
    m = Security(
        id=_uid(), code=norm, name=name, exchange="SH", asset_class=SecurityType.STOCK,
    )
    session.add(m)
    await session.flush()
    return m


def _cn_row(*, report, ptype="年度分红", cash="219.1", bonus="", convert="",
            ex="", record="", ann="") -> dict:
    """构造巨潮 ``stock_dividend_cninfo`` 响应行（11 列；金额列为「每 10 股」口径）。

    未落库的三列（派息日 / 股份到账日 / 实施方案分红说明）按 §9.3-A6 仅占位不消费。
    """
    return {
        COL_ANN: ann,
        COL_PERIOD_TYPE: ptype,
        COL_CONVERT: convert,
        COL_BONUS: bonus,
        COL_CASH: cash,
        COL_RECORD: record,
        COL_EX: ex,
        COL_PAY: "",
        COL_ARRIVE: "",
        COL_DESC: "10派21.91元",
        COL_REPORT: report,
    }


def _div_row(master_id, cash, status=DividendStatus.PROPOSED, ry=None, rq=None,
             ex=None, ann=None, period_type=ReportPeriodType.ANNUAL,
             source="巨潮-历史分红"):
    return SecurityDividend(
        master_id=master_id,
        report_year=ry or _cur_year(),
        report_quarter=rq or 1,
        period_type=period_type,
        cash_per_share=Decimal(cash),
        status=status,
        ex_dividend_date=ex,
        announcement_date=ann,
        source=source,
    )


def _make_raw(detail_rows=None, notice_rows=()):
    """构造 ``call_interface_raw`` 替身：按接口分类分派（分类 4 公告 / 分类 3 明细）。

    ``detail_rows`` 按 ``params["symbol"]`` 取行（逐只形态）；返回副本，避免用例间
    跨调用共享同一 dict 被 upsert 就地改写。
    """
    detail_rows = detail_rows or {}
    calls: list[tuple[object, dict]] = []

    async def _fake(*args):
        # 兼容两类替换方式：实例属性赋值（itf, params, codes）与类级 monkeypatch
        # （多一个 self 前导参数）；取末三位即 (itf, params, codes)。
        itf, params = args[-3], args[-2]
        params = dict(params or {})
        calls.append((itf, params))
        if getattr(itf, "category_id", None) == NOTICE_CAT_ID:
            return list(notice_rows)
        return [dict(r) for r in detail_rows.get(str(params.get("symbol")), [])]

    return _fake, calls


async def _ensure_categories(session) -> None:
    for cid, label in ((NOTICE_CAT_ID, "公司公告"), (DIVIDEND_LIST_CAT_ID, "股息列表")):
        if await session.get(InterfaceCategory, cid) is None:
            session.add(InterfaceCategory(id=cid, label=label, system=True))
    await session.flush()


async def _seed_sources(session, *, detail_params=None, provider_enabled=True,
                        notice_enabled=True, detail_enabled=True):
    """建分类行 + 公司公告接口（分类 4）+ 明细源（分类 3）+ 全局设置指向二者。"""
    await _ensure_categories(session)
    provider = SecuritiesDataProvider(
        id=_uid(), name="akshare", access_method="sdk", config={}, enabled=provider_enabled,
    )
    session.add(provider)
    await session.flush()
    notice = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=NOTICE_CAT_ID,
        name="沪深京 A 股公告", endpoint="stock_notice_report",
        enabled=notice_enabled, priority=1, params={"symbol": "财务报告"},
    )
    detail = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=DIVIDEND_LIST_CAT_ID,
        name="巨潮-历史分红", endpoint="stock_dividend_cninfo", enabled=detail_enabled,
        priority=1,
        params={"symbol": "000000"} if detail_params is None else detail_params,
    )
    session.add_all([notice, detail])
    # 显式 flush：设置行与接口行之间无 ORM 关系，SQLAlchemy 无法据此拓扑排序，
    # 不先落接口行会撞 dividend_yield_settings 的 FK（无兜底，须保持顺序）。
    await session.flush()
    session.add(DividendYieldSettings(
        id=_uid(),
        announcement_source_interface_id=notice.id,
        dividend_detail_source_interface_id=detail.id,
    ))
    await session.commit()
    return notice, detail


async def _div_rows(session, master_id) -> list[SecurityDividend]:
    return (
        await session.execute(
            select(SecurityDividend)
            .where(SecurityDividend.master_id == master_id)
            .order_by(SecurityDividend.report_year, SecurityDividend.report_quarter)
        )
    ).scalars().all()


# ───────────── 标题正则二筛（§5.5 / 附录 A.7、A.10） ─────────────
def test_title_dividend_regex_keywords():
    """守护附录 A.7：分红相关关键词收全 `分红|派息|权益分派|利润分配|分配方案`。"""
    assert _TITLE_DIVIDEND_RE.search("贵州茅台2022年度回报股东特别分红实施公告")
    assert _TITLE_DIVIDEND_RE.search("2024年中期权益分派实施公告")
    assert _TITLE_DIVIDEND_RE.search("公司20xx年度利润分配方案公告")
    assert _TITLE_DIVIDEND_RE.search("派息公告")
    assert _TITLE_DIVIDEND_RE.search("权益分派实施公告")


def test_title_cancel_regex():
    """守护附录 A.10：`取消|终止` 落在分红相关标题上 → cancel。"""
    assert _TITLE_CANCEL_RE.search("关于取消2022年度利润分配方案的公告")
    assert _TITLE_CANCEL_RE.search("关于终止分红实施方案的公告")


@pytest.mark.asyncio
async def test_classify_notices_candidate_and_cancel(session):
    """守护 §6.8：公告行经标题二筛归一为 (master_id, kind)；未命中证券跳过；hits 计数。"""
    m = await _add_master(session)
    await session.commit()
    itf = QuoteInterface(
        id=_uid(), provider_id=_uid(), category_id=NOTICE_CAT_ID,
        name="东北公告", enabled=True, resp_code_field="代码",
    )
    svc = DividendNoticeScanService(session)
    stats = _new_stats()
    rows = [
        {"代码": "600519", "公告标题": "贵州茅台2022年度回报股东特别分红实施公告"},  # 候选
        {"代码": "600519", "公告标题": "关于终止年度利润分配方案的公告"},          # 取消
        {"代码": "000000", "公告标题": "其他非分红公告"},                          # 未命中
    ]
    events = await svc._classify_notices(itf, rows, stats)
    assert (m.id, "candidate") in events
    assert (m.id, "cancel") in events
    assert stats["hits"] == 2


@pytest.mark.asyncio
async def test_classify_notices_plain_annual_notice_is_candidate(session):
    """§5.5 放宽：标题无「特别|中期」的**普通年度分红公告**也须命中候选。

    这是对旧断言（"普通年度分红不算命中"）的反转——新方法按股拉全历史，漏掉年报
    分红等于漏掉绝大多数分红。
    """
    m = await _add_master(session)
    await session.commit()
    itf = QuoteInterface(
        id=_uid(), provider_id=_uid(), category_id=NOTICE_CAT_ID,
        name="东北公告", enabled=True, resp_code_field="代码",
    )
    svc = DividendNoticeScanService(session)
    stats = _new_stats()
    rows = [
        {"代码": "600519", "公告标题": "XX公司2025年度权益分派实施公告"},
        {"代码": "600519", "公告标题": "XX公司2025年度利润分配方案公告"},
    ]
    events = await svc._classify_notices(itf, rows, stats)
    assert events == [(m.id, "candidate"), (m.id, "candidate")]
    assert stats["hits"] == 2


@pytest.mark.asyncio
async def test_classify_notices_cancel_is_not_candidate(session):
    """§5.5：命中分红正则且含「取消|终止」→ 只归 cancel，不进候选集合。"""
    m = await _add_master(session)
    await session.commit()
    itf = QuoteInterface(
        id=_uid(), provider_id=_uid(), category_id=NOTICE_CAT_ID,
        name="东北公告", enabled=True, resp_code_field="代码",
    )
    svc = DividendNoticeScanService(session)
    stats = _new_stats()
    rows = [
        {"代码": "600519", "公告标题": "关于取消2022年度利润分配方案的公告"},
        {"代码": "600519", "公告标题": "2024年中期分红终止实施公告"},
    ]
    events = await svc._classify_notices(itf, rows, stats)
    assert events == [(m.id, "cancel"), (m.id, "cancel")]
    assert stats["hits"] == 2


# ───────────── §5.3 / §9.3-A3 纯解析口径 ─────────────
def test_parse_period_type_labels():
    """§5.3（批次 A）：分红类型 5 项精确映射；未收录/空/None → OTHER。"""
    assert parse_period_type("年度分红") is ReportPeriodType.ANNUAL
    assert parse_period_type("中期分红") is ReportPeriodType.INTERIM
    assert parse_period_type("季度分红") is ReportPeriodType.QUARTERLY
    assert parse_period_type("特别分红") is ReportPeriodType.SPECIAL
    assert parse_period_type("股改分红") is ReportPeriodType.OTHER
    assert parse_period_type("") is ReportPeriodType.OTHER
    assert parse_period_type(None) is ReportPeriodType.OTHER


def test_retention_cutoff_year_is_true_five_years():
    """§9.3-A3：默认 5 年 → 留存窗 ``[cur-4, cur]``；years 由调用方传入（对齐 retention_cleanup）。"""
    assert retention_cutoff_year(date(2026, 1, 1), years=5) == 2022
    assert retention_cutoff_year(date(2026, 12, 31), years=5) == 2022
    assert retention_cutoff_year(date(2027, 6, 1), years=5) == 2023


def test_retention_cutoff_year_follows_configured_years():
    """D-4：years 取配置值 → 与 cleanup 同公式，采集窗随配置伸缩（非硬编码 5）。

    反向断言：若 years 被忽略（回退成硬编码 5），2026 年配 3 会得 2022 而非 2024 → 用例变红。
    """
    assert retention_cutoff_year(date(2026, 6, 1), years=3) == 2024
    assert retention_cutoff_year(date(2026, 6, 1), years=8) == 2019
    assert retention_cutoff_year(date(2026, 6, 1), years=1) == 2026


# ───────────── §5.2 调用编排 ─────────────
@pytest.mark.parametrize("code", ["sh600519", "SH600519", "600519.SH", "600519"])
@pytest.mark.asyncio
async def test_fetch_symbol_is_digits_only(session, code):
    """§5.2：``symbol`` = 证券代码纯数字（sh600519 → 600519），且覆盖接口自带 symbol。"""
    m = await _add_master(session)
    _notice, detail = await _seed_sources(session)
    svc = DividendNoticeScanService(session)
    fake, calls = _make_raw({"600519": [_cn_row(report=f"{_cur_year() - 1}年报")]})
    svc._mds.call_interface_raw = fake
    await svc.fetch_and_upsert_master(m.id, code, detail, _new_stats())

    detail_calls = [c for c in calls if getattr(c[0], "category_id", None) == DIVIDEND_LIST_CAT_ID]
    assert len(detail_calls) == 1
    params = detail_calls[0][1]
    assert params["symbol"] == "600519"
    # 接口配置里的 symbol 占位被本次证券代码覆盖（§5.2：代码取调用方参数）
    assert params == {"symbol": "600519"}


@pytest.mark.asyncio
async def test_fetch_iterates_all_returned_rows(session):
    """§5.2：遍历**全部**返回行（不再是「取当天那一条」），逐行按报告期落格。"""
    m = await _add_master(session)
    _notice, detail = await _seed_sources(session)
    cur = _cur_year()
    svc = DividendNoticeScanService(session)
    rows = [
        _cn_row(report=f"{cur - 1}年报", cash="100", ex=f"{cur - 1}-06-10"),
        _cn_row(report=f"{cur - 2}年报", cash="90", ex=f"{cur - 2}-06-10"),
        _cn_row(report=f"{cur - 3}年报", cash="80", ex=f"{cur - 3}-06-10"),
    ]
    svc._mds.call_interface_raw = _make_raw({"600519": rows})[0]
    stats = _new_stats()
    assert await svc.fetch_and_upsert_master(m.id, "sh600519", detail, stats) is True
    await session.commit()

    stored = await _div_rows(session, m.id)
    assert [(r.report_year, r.report_quarter) for r in stored] == [
        (cur - 3, 4), (cur - 2, 4), (cur - 1, 4),
    ]
    assert stats["new"] == 3
    assert stats["skip"] == 0 and stats["window"] == 0


@pytest.mark.asyncio
async def test_fetch_cuts_rows_outside_true_five_year_window(session):
    """§9.3-A3：``report_year < cur-4`` 的行跳过并计入 ``stats['window']``。"""
    m = await _add_master(session)
    _notice, detail = await _seed_sources(session)
    cur = _cur_year()
    svc = DividendNoticeScanService(session)
    rows = [
        _cn_row(report=f"{cur - 5}年报", cash="10"),   # 窗口外（第 6 个财年）
        _cn_row(report=f"{cur - 4}年报", cash="20"),   # 窗口内下界（须保留）
    ]
    svc._mds.call_interface_raw = _make_raw({"600519": rows})[0]
    stats = _new_stats()
    await svc.fetch_and_upsert_master(m.id, "sh600519", detail, stats)
    await session.commit()

    stored = await _div_rows(session, m.id)
    assert [r.report_year for r in stored] == [cur - 4]
    assert stats["window"] == 1
    assert stats["new"] == 1


# ───────────── §5.3 / §9.3-A1 跳行口径 ─────────────
@pytest.mark.asyncio
async def test_pure_bonus_row_not_persisted(session):
    """§9.3-A1（批次 A 命名 A）：纯送转行（派息比例空）不落库，计入 ``stats['skip']``（无派息）。"""
    m = await _add_master(session)
    _notice, detail = await _seed_sources(session)
    svc = DividendNoticeScanService(session)
    rows = [_cn_row(report=f"{_cur_year() - 1}年报", cash="", bonus="3", convert="5")]
    svc._mds.call_interface_raw = _make_raw({"600519": rows})[0]
    stats = _new_stats()
    assert await svc.fetch_and_upsert_master(m.id, "sh600519", detail, stats) is False
    await session.commit()

    assert await _div_rows(session, m.id) == []
    assert stats["skip"] == 1
    assert stats["new"] == 0


@pytest.mark.asyncio
async def test_explicit_zero_cash_not_persisted(session):
    """§5.3：派息比例显式 0 → 同「空」口径，跳过不落库。"""
    m = await _add_master(session)
    _notice, detail = await _seed_sources(session)
    svc = DividendNoticeScanService(session)
    rows = [_cn_row(report=f"{_cur_year() - 1}年报", cash="0", bonus="3")]
    svc._mds.call_interface_raw = _make_raw({"600519": rows})[0]
    stats = _new_stats()
    await svc.fetch_and_upsert_master(m.id, "sh600519", detail, stats)
    await session.commit()

    assert await _div_rows(session, m.id) == []
    assert stats["skip"] == 1


@pytest.mark.asyncio
async def test_unparsable_report_period_not_persisted(session):
    """§5.3（批次 A/B）：「报告时间」不可解析 → 有派息但无报告期，跳过计入 ``stats['no_period']``；
    批次 B 起落 staging 待人工划分（``staged`` 计数 + pending 行），仍**不落主表**。
    """
    m = await _add_master(session)
    _notice, detail = await _seed_sources(session)
    svc = DividendNoticeScanService(session)
    rows = [
        _cn_row(report="", cash="100"),
        _cn_row(report="未知报告期", cash="100"),
    ]
    svc._mds.call_interface_raw = _make_raw({"600519": rows})[0]
    stats = _new_stats()
    await svc.fetch_and_upsert_master(m.id, "sh600519", detail, stats)
    await session.commit()

    assert await _div_rows(session, m.id) == []
    assert stats["skip"] == 0
    assert stats["no_period"] == 2
    # 批次 B：两行报告时间原文不同（None / "未知报告期"）→ 各入队一行，主表仍无写入
    assert stats["staged"] == 2
    pending = (
        await session.execute(
            select(SecurityDividendPending).where(SecurityDividendPending.master_id == m.id)
        )
    ).scalars().all()
    assert len(pending) == 2


# ───────────── §5.3 字段映射 / §5.4 status 判据 ─────────────
@pytest.mark.asyncio
async def test_fetch_maps_cninfo_columns_to_target_row(session):
    """§5.3：巨潮列 → 目标列；金额按「每 10 股」÷10 折算为每股。"""
    m = await _add_master(session)
    _notice, detail = await _seed_sources(session)
    svc = DividendNoticeScanService(session)
    rows = [_cn_row(
        report=f"{_cur_year() - 1}年报", ptype="年度分红", cash="219.1",
        bonus="3", convert="5", ex=f"{_cur_year() - 1}-06-10",
        record=f"{_cur_year() - 1}-06-09", ann=f"{_cur_year() - 1}-05-20",
    )]
    svc._mds.call_interface_raw = _make_raw({"600519": rows})[0]
    stats = _new_stats()
    await svc.fetch_and_upsert_master(m.id, "sh600519", detail, stats)
    await session.commit()

    row = (await _div_rows(session, m.id))[0]
    assert row.cash_per_share == Decimal("21.91")        # 219.1 / 10
    assert row.bonus_share_ratio == Decimal("0.3")       # 3 / 10
    assert row.convert_ratio == Decimal("0.5")           # 5 / 10
    assert row.ex_dividend_date == date(_cur_year() - 1, 6, 10)
    assert row.record_date == date(_cur_year() - 1, 6, 9)
    assert row.announcement_date == date(_cur_year() - 1, 5, 20)
    assert row.source == "巨潮-历史分红"
    assert stats["new"] == 1


@pytest.mark.asyncio
async def test_status_paid_when_ex_date_else_proposed(session):
    """§5.4 / §9.3-A2：除权日非空 → PAID，否则 PROPOSED（巨潮无「进度」列）。"""
    m = await _add_master(session)
    _notice, detail = await _seed_sources(session)
    cur = _cur_year()
    svc = DividendNoticeScanService(session)
    rows = [
        _cn_row(report=f"{cur - 1}年报", cash="100", ex=f"{cur - 1}-06-10"),
        _cn_row(report=f"{cur - 1}半年报", ptype="中期分红", cash="50", ex=""),
    ]
    svc._mds.call_interface_raw = _make_raw({"600519": rows})[0]
    await svc.fetch_and_upsert_master(m.id, "sh600519", detail, _new_stats())
    await session.commit()

    by_cell = {(r.report_quarter, r.period_type): r for r in await _div_rows(session, m.id)}
    annual = by_cell[(4, ReportPeriodType.ANNUAL)]
    interim = by_cell[(2, ReportPeriodType.INTERIM)]
    assert annual.status is DividendStatus.PAID
    assert annual.ex_dividend_date == date(cur - 1, 6, 10)
    assert interim.status is DividendStatus.PROPOSED
    assert interim.ex_dividend_date is None


@pytest.mark.asyncio
async def test_period_type_mapped_from_dividend_type(session):
    """§5.3 端到端（批次 A）：分红类型「年度/中期/季度/其它」→ ANNUAL / INTERIM / QUARTERLY / OTHER。"""
    m = await _add_master(session)
    _notice, detail = await _seed_sources(session)
    cur = _cur_year()
    svc = DividendNoticeScanService(session)
    rows = [
        _cn_row(report=f"{cur - 1}年报", ptype="年度分红", cash="100"),
        _cn_row(report=f"{cur - 1}半年报", ptype="中期分红", cash="50"),
        _cn_row(report=f"{cur - 1}一季报", ptype="季度分红", cash="30"),
    ]
    svc._mds.call_interface_raw = _make_raw({"600519": rows})[0]
    await svc.fetch_and_upsert_master(m.id, "sh600519", detail, _new_stats())
    await session.commit()

    by_cell = {r.report_quarter: r for r in await _div_rows(session, m.id)}
    assert by_cell[4].period_type is ReportPeriodType.ANNUAL     # 年度分红 + 年报
    assert by_cell[2].period_type is ReportPeriodType.INTERIM    # 中期分红 + 半年报
    assert by_cell[1].period_type is ReportPeriodType.QUARTERLY  # 其它类型 + 一季报


# ───────────── §5.6 幂等去重 ─────────────
@pytest.mark.asyncio
async def test_upsert_idempotent_and_refreshes_dates(session):
    """§5.6：同唯一键重复运行不产生重复行；同格同额但日期变化的行**必须**被更新。

    旧「(ry,rq,cash) 全等 → 跳过」分支会永久挡住同格同额行的日期刷新（PROPOSED
    升不了 PAID），已在 P0 移除——本用例即该行为的护栏，不得反向放宽。
    """
    m = await _add_master(session)
    _notice, detail = await _seed_sources(session)
    cur = _cur_year()
    svc = DividendNoticeScanService(session)
    svc._mds.call_interface_raw = _make_raw({"600519": [
        _cn_row(report=f"{cur - 1}年报", cash="100", ex=""),
    ]})[0]

    first = _new_stats()
    await svc.fetch_and_upsert_master(m.id, "sh600519", detail, first)
    await session.commit()
    assert first["new"] == 1
    assert (await _div_rows(session, m.id))[0].status is DividendStatus.PROPOSED

    # 同格同额重跑：不新增、不变更
    second = _new_stats()
    assert await svc.fetch_and_upsert_master(m.id, "sh600519", detail, second) is False
    await session.commit()
    assert len(await _div_rows(session, m.id)) == 1
    assert second["new"] == 0 and second["upd"] == 0

    # 同格同额但补上除权日：须刷新（金额未变也不可跳过）
    svc._mds.call_interface_raw = _make_raw({"600519": [
        _cn_row(report=f"{cur - 1}年报", cash="100", ex=f"{cur - 1}-06-10"),
    ]})[0]
    third = _new_stats()
    assert await svc.fetch_and_upsert_master(m.id, "sh600519", detail, third) is True
    await session.commit()

    stored = await _div_rows(session, m.id)
    assert len(stored) == 1
    assert stored[0].ex_dividend_date == date(cur - 1, 6, 10)
    assert stored[0].status is DividendStatus.PAID
    assert stored[0].cash_per_share == Decimal("10.0")
    assert third["new"] == 0 and third["upd"] == 1


# ───────────── scan() 端到端 ─────────────
@pytest.mark.asyncio
async def test_scan_plain_annual_notice_triggers_fetch(session, monkeypatch):
    """§5.5 端到端：普通年度分红公告（无「特别|中期」）命中候选 → 拉全历史并落库。"""
    m = await _add_master(session)
    _notice, _detail = await _seed_sources(session)
    cur = _cur_year()
    mid = m.id  # 纯字符串：避免 rollback 后读 ORM 属性触发同步惰性加载
    notice_rows = [{"代码": "600519", "公告标题": "XX公司2025年度权益分派实施公告"}]
    fake, _calls = _make_raw(
        {"600519": [_cn_row(report=f"{cur - 1}年报", cash="100")]}, notice_rows,
    )
    monkeypatch.setattr(MarketDataSyncService, "call_interface_raw", fake)

    result = await DividendNoticeScanService(session).scan(None)
    await session.commit()

    stored = await _div_rows(session, mid)
    assert len(stored) == 1
    assert stored[0].report_year == cur - 1
    assert stored[0].period_type is ReportPeriodType.ANNUAL
    assert "新写1" in result and "命中1" in result


@pytest.mark.asyncio
async def test_scan_cancel_notice_rejects_proposed(session, monkeypatch):
    """取消公告：该证券存量 PROPOSED 行置 REJECTED，且**不**触发采集。"""
    m = await _add_master(session)
    _notice, _detail = await _seed_sources(session)
    mid = m.id  # 纯字符串：避免 rollback 后读 ORM 属性触发同步惰性加载
    proposed = _div_row(mid, "19.0", status=DividendStatus.PROPOSED,
                        ry=_cur_year() - 1, rq=4)
    session.add(proposed)
    await session.commit()

    notice_rows = [{"代码": "600519", "公告标题": "关于取消2025年度利润分配方案的公告"}]
    fake, calls = _make_raw({"600519": [_cn_row(report=f"{_cur_year() - 1}年报")]},
                            notice_rows)
    monkeypatch.setattr(MarketDataSyncService, "call_interface_raw", fake)

    result = await DividendNoticeScanService(session).scan(None)
    await session.commit()
    await session.refresh(proposed)

    assert proposed.status is DividendStatus.REJECTED
    assert "更新1" in result
    # 取消路径不拉明细（want_fetch = False）
    assert all(getattr(c[0], "category_id", None) == NOTICE_CAT_ID for c in calls)


@pytest.mark.asyncio
async def test_scan_single_master_failure_continues(session, monkeypatch):
    """§5.2 容错：单只失败 rollback 后继续下一只，失败数计入 ``stats['skipped']``。"""
    a = await _add_master(session, code="600519", name="证券A")
    b = await _add_master(session, code="000001", name="证券B")
    _notice, _detail = await _seed_sources(session)
    cur = _cur_year()
    notice_rows = [
        {"代码": "600519", "公告标题": "证券A2025年度利润分配方案公告"},
        {"代码": "000001", "公告标题": "证券B2025年度利润分配方案公告"},
    ]
    detail_rows = {
        "600519": [_cn_row(report=f"{cur - 1}年报", cash="100")],
        "000001": [_cn_row(report=f"{cur - 1}年报", cash="50")],
    }
    fake, _calls = _make_raw(detail_rows, notice_rows)
    monkeypatch.setattr(MarketDataSyncService, "call_interface_raw", fake)

    # 关键：先取纯字符串再驱动 scan。失败路径的 ``rollback()`` 会 expire 会话内全部
    # ORM 实例，此后读 ``a.code`` / ``a.id`` 会触发**同步**惰性加载 → MissingGreenlet，
    # 会把「下一只也失败」误算进 stats（测试自身的坑，非被测行为）。
    code_a, mid_a, mid_b = a.code, a.id, b.id

    original = DividendNoticeScanService.fetch_and_upsert_master

    async def _flaky(self, mid, code, detail, stats, retention_years=None):
        if code == code_a:  # 仅 A 失败
            raise RuntimeError("巨潮单只调用失败")
        return await original(self, mid, code, detail, stats, retention_years)

    monkeypatch.setattr(DividendNoticeScanService, "fetch_and_upsert_master", _flaky)

    result = await DividendNoticeScanService(session).scan(None)
    await session.commit()

    assert "失败1只" in result
    assert await _div_rows(session, mid_a) == []                # A 已 rollback
    b_rows = await _div_rows(session, mid_b)
    assert len(b_rows) == 1 and b_rows[0].cash_per_share == Decimal("5.0")
    assert "新写1" in result and "重算1只" in result


# ───────────── 既有护栏（未随迁移删除） ─────────────
@pytest.mark.asyncio
async def test_westward_dup_by_ex_date_and_identity(session):
    """L2：去重护栏改为跨源限定——同源（兄弟分量）豁免，跨源重复才跳过。"""
    m = await _add_master(session)
    session.add(_div_row(m.id, "19.0", status=DividendStatus.PAID,
                         ry=2022, rq=4, ex=date(2022, 12, 27)))
    await session.commit()

    svc = DividendNoticeScanService(session)
    SAME = "巨潮-历史分红"      # 与存量行同源
    OTHER = "新浪-分红配股"     # 跨源
    # 跨源 + ex_date 相等 → True（挡住旧链路同名行）
    assert await svc._westward_dup(
        m.id, date(2022, 12, 27), 2022, 4, Decimal("19.0"), OTHER) is True
    # 跨源 + (ry,rq,cash) 全等 → True（即使 ex_date 不同）
    assert await svc._westward_dup(
        m.id, None, 2022, 4, Decimal("19.0"), OTHER) is True
    # 同源 + ex_date 相等 → False（同源豁免：巨潮同 ex_date 的兄弟分量不被误杀）
    assert await svc._westward_dup(
        m.id, date(2022, 12, 27), 2022, 4, Decimal("19.0"), SAME) is False
    # 同源 + (ry,rq,cash) 全等 → False（同源豁免）
    assert await svc._westward_dup(
        m.id, None, 2022, 4, Decimal("19.0"), SAME) is False
    # 无命中 → False
    assert await svc._westward_dup(
        m.id, None, 2023, 1, Decimal("1.0"), OTHER) is False


@pytest.mark.asyncio
async def test_westward_dup_keeps_same_source_sibling_components(session):
    """L2 端到端：同源兄弟分量（同 ex_date、异 cash、异 period_type）两行都落库，不被误杀。

    复刻巨潮 300750 2023Q4「年度 20.11 + 特别 30.17」同 ex_date 拆两行的真实形态。
    修复前：第二分量会被 ``ex_date`` 分支判重而整行丢弃（实际只剩 1 行）。
    """
    m = await _add_master(session)
    _notice, detail = await _seed_sources(session)
    cur = _cur_year()
    svc = DividendNoticeScanService(session)
    svc._mds.call_interface_raw = _make_raw({"600519": [
        _cn_row(report=f"{cur - 1}年报", ptype="年度分红", cash="20.11", ex=f"{cur - 1}-06-01"),
        _cn_row(report=f"{cur - 1}年报", ptype="特别分红", cash="30.17", ex=f"{cur - 1}-06-01"),
    ]})[0]
    stats = _new_stats()
    await svc.fetch_and_upsert_master(m.id, "sh600519", detail, stats)
    await session.commit()
    rows = await _div_rows(session, m.id)
    assert len(rows) == 2, f"兄弟分量应两行都保留，实际 {len(rows)} 行"
    assert stats["new"] == 2
    assert stats["anchor"] == 0  # 同源豁免，不应走 anchor 跳过


@pytest.mark.asyncio
async def test_westward_dup_skips_cross_source_duplicate(session):
    """L2 端到端（回归护栏）：跨源重复（旧新浪 SPECIAL 行已存在 + 新巨潮同 ex_date/cash）
    仍应被去重护栏跳过，不得因同源豁免而漏挡。
    """
    m = await _add_master(session)
    _notice, detail = await _seed_sources(session)
    cur = _cur_year()
    # 存量：旧新浪链路把每行都写成 SPECIAL（与新巨潮 ANNUAL 唯一键不同 → 走 _westward_dup）
    session.add(_div_row(m.id, "19.0", status=DividendStatus.PAID, ry=cur - 1, rq=4,
                         ex=date(cur - 1, 6, 1), period_type=ReportPeriodType.SPECIAL,
                         source="新浪-分红配股"))
    await session.commit()
    svc = DividendNoticeScanService(session)
    svc._mds.call_interface_raw = _make_raw({"600519": [
        _cn_row(report=f"{cur - 1}年报", ptype="年度分红", cash="19.0", ex=f"{cur - 1}-06-01"),
    ]})[0]
    stats = _new_stats()
    await svc.fetch_and_upsert_master(m.id, "sh600519", detail, stats)
    await session.commit()
    rows = await _div_rows(session, m.id)
    assert len(rows) == 1, f"跨源重复应被去重，实际 {len(rows)} 行"
    assert stats["new"] == 0 and stats["anchor"] == 1


# ───────────── 公司公告接口解析（§5.4 可配置化） ─────────────
async def _seed_cat4(session, *, priority=1, enabled=True, name="沪深京 A 股公告",
                     provider_enabled=True):
    """分类 4「公司公告」+ 公告接口行（params 含 symbol，逐只形态）；分类行幂等。"""
    if await session.get(InterfaceCategory, NOTICE_CAT_ID) is None:
        session.add(InterfaceCategory(id=NOTICE_CAT_ID, label="公司公告", system=True))
    provider = SecuritiesDataProvider(
        id=_uid(), name="akshare", access_method="sdk", config={}, enabled=provider_enabled,
    )
    session.add(provider)
    await session.flush()
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=NOTICE_CAT_ID,
        name=name, endpoint="stock_notice_report", enabled=enabled, priority=priority,
        params={"symbol": "财务报告"},
    )
    session.add(itf)
    await session.commit()
    return itf


@pytest.mark.asyncio
async def test_resolve_notice_itf_uses_configured_source(session):
    """守护 §5.4：配置了 announcement_source_interface_id → 直接使用该接口。"""
    itf = await _seed_cat4(session, priority=2)
    session.add(DividendYieldSettings(
        id=_uid(), announcement_source_interface_id=itf.id,
    ))
    await session.commit()
    svc = DividendNoticeScanService(session)
    resolved = await svc._resolve_notice_itf(await svc._settings())
    assert resolved.id == itf.id


@pytest.mark.asyncio
async def test_resolve_notice_itf_configured_disabled_fails_closed(session):
    """守护 §5.4 fail closed：配置的公司公告接口已停用 → fail fast raise，不静默回退分类 4 其他接口。"""
    itf = await _seed_cat4(session, enabled=False)
    await _seed_cat4(session, priority=1, name="备用公告接口")  # 若静默回退会选中它
    session.add(DividendYieldSettings(
        id=_uid(), announcement_source_interface_id=itf.id,
    ))
    await session.commit()
    svc = DividendNoticeScanService(session)
    with pytest.raises(RuntimeError, match="已停用"):
        await svc._resolve_notice_itf(await svc._settings())


@pytest.mark.asyncio
async def test_resolve_notice_itf_unconfigured_falls_back_to_priority_min(session):
    """守护 §11.2-7：未配置 → 回退分类 4 enabled 中 priority 最小（NULLS LAST）的接口。"""
    high = await _seed_cat4(session, priority=10, name="高序号公告接口")
    low = await _seed_cat4(session, priority=1, name="低序号公告接口")
    null_p = await _seed_cat4(session, priority=None, name="无序号公告接口")
    svc = DividendNoticeScanService(session)
    resolved = await svc._resolve_notice_itf(await svc._settings())
    assert resolved.id == low.id
    assert resolved.id not in (high.id, null_p.id)


@pytest.mark.asyncio
async def test_resolve_notice_itf_no_candidate_fails_fast(session):
    """守护 §6.8：未配置且分类 4 无 enabled 接口 → fail fast raise。"""
    svc = DividendNoticeScanService(session)
    with pytest.raises(RuntimeError, match="缺失或已停用"):
        await svc._resolve_notice_itf(await svc._settings())


@pytest.mark.asyncio
async def test_resolve_notice_itf_provider_disabled_fails_closed(session):
    """守护 ADR-002 #1 口径：配置的公司公告接口 enabled 但**提供方**已停用 → fail fast，
    不静默回退（所有选源路径须过滤提供方 enabled，否则停用提供方被照常选用）。"""
    itf = await _seed_cat4(session, provider_enabled=False)
    await _seed_cat4(session, priority=1, name="备用公告接口")  # 若静默回退会选中它
    session.add(DividendYieldSettings(
        id=_uid(), announcement_source_interface_id=itf.id,
    ))
    await session.commit()
    svc = DividendNoticeScanService(session)
    with pytest.raises(RuntimeError, match="已停用"):
        await svc._resolve_notice_itf(await svc._settings())


@pytest.mark.asyncio
async def test_resolve_detail_itf_provider_disabled_returns_none(session):
    """明细源同口径：接口 enabled 但提供方停用 → 返回 None（记告警跳过，不逐只调用）。"""
    itf = await _seed_cat4(session, provider_enabled=False)
    session.add(DividendYieldSettings(
        id=_uid(), dividend_detail_source_interface_id=itf.id,
    ))
    await session.commit()
    svc = DividendNoticeScanService(session)
    resolved = await svc._resolve_detail_itf(await svc._settings())
    assert resolved is None


# ───────────── 批次 A：OTHER 枚举 / 原文标签 / 撞键护栏 ─────────────
@pytest.mark.asyncio
async def test_fetch_sharereform_row_persisted_as_other(session):
    """端到端 #10：股改分红行落库，period_type=OTHER 且 dividend_label 透传原文。"""
    m = await _add_master(session)
    _notice, detail = await _seed_sources(session)
    cur = _cur_year()
    svc = DividendNoticeScanService(session)
    rows = [_cn_row(
        report=f"{cur - 1}年报", ptype="股改分红", cash="100", ex=f"{cur - 1}-06-10",
    )]
    svc._mds.call_interface_raw = _make_raw({"600519": rows})[0]
    stats = _new_stats()
    await svc.fetch_and_upsert_master(m.id, "sh600519", detail, stats)
    await session.commit()

    stored = await _div_rows(session, m.id)
    assert len(stored) == 1
    assert stored[0].period_type is ReportPeriodType.OTHER
    assert stored[0].dividend_label == "股改分红"
    assert stats["new"] == 1
    assert stats["unknown_label"] == 0  # 股改是已收录标签


@pytest.mark.asyncio
async def test_fetch_unknown_label_persisted_as_other(session):
    """端到端 #11：未收录标签落 OTHER，原文 dividend_label 透传，计 unknown_label==1。"""
    m = await _add_master(session)
    _notice, detail = await _seed_sources(session)
    cur = _cur_year()
    svc = DividendNoticeScanService(session)
    rows = [_cn_row(
        report=f"{cur - 1}年报", ptype="承诺补偿", cash="100", ex=f"{cur - 1}-06-10",
    )]
    svc._mds.call_interface_raw = _make_raw({"600519": rows})[0]
    stats = _new_stats()
    await svc.fetch_and_upsert_master(m.id, "sh600519", detail, stats)
    await session.commit()

    stored = await _div_rows(session, m.id)
    assert len(stored) == 1
    assert stored[0].period_type is ReportPeriodType.OTHER
    assert stored[0].dividend_label == "承诺补偿"
    assert stats["unknown_label"] == 1


@pytest.mark.asyncio
async def test_collision_guard_keeps_old_label(session):
    """🔴 撞键 #12：同唯一键(OTHER)新旧标签均非空且不等 → 整行不更新，保留旧值。

    先写 股改分红/cash=1.0，再拉 承诺补偿/cash=2.0：唯一键相同（均 OTHER），命中撞键护栏，
    库内仍 1 行、cash 未覆盖、dividend_label 仍旧，collision==1、upd==0。
    """
    m = await _add_master(session)
    _notice, detail = await _seed_sources(session)
    cur = _cur_year()
    svc = DividendNoticeScanService(session)

    svc._mds.call_interface_raw = _make_raw({"600519": [
        _cn_row(report=f"{cur - 1}年报", ptype="股改分红", cash="10", ex=f"{cur - 1}-06-10"),
    ]})[0]
    first = _new_stats()
    await svc.fetch_and_upsert_master(m.id, "sh600519", detail, first)
    await session.commit()
    assert first["new"] == 1

    svc._mds.call_interface_raw = _make_raw({"600519": [
        _cn_row(report=f"{cur - 1}年报", ptype="承诺补偿", cash="20", ex=f"{cur - 1}-07-10"),
    ]})[0]
    second = _new_stats()
    await svc.fetch_and_upsert_master(m.id, "sh600519", detail, second)
    await session.commit()

    stored = await _div_rows(session, m.id)
    assert len(stored) == 1
    assert stored[0].cash_per_share == Decimal("1.0")  # 未覆盖
    assert stored[0].dividend_label == "股改分红"       # 保留旧标签
    assert second["collision"] == 1
    assert second["upd"] == 0


@pytest.mark.asyncio
async def test_collision_guard_exempt_same_label_refreshes(session):
    """护栏豁免 #13：同标签重扫（补除权日）→ 正常刷新，collision==0、upd==1。"""
    m = await _add_master(session)
    _notice, detail = await _seed_sources(session)
    cur = _cur_year()
    svc = DividendNoticeScanService(session)

    svc._mds.call_interface_raw = _make_raw({"600519": [
        _cn_row(report=f"{cur - 1}年报", ptype="股改分红", cash="10", ex=""),
    ]})[0]
    first = _new_stats()
    await svc.fetch_and_upsert_master(m.id, "sh600519", detail, first)
    await session.commit()
    assert first["new"] == 1

    svc._mds.call_interface_raw = _make_raw({"600519": [
        _cn_row(report=f"{cur - 1}年报", ptype="股改分红", cash="10", ex=f"{cur - 1}-06-10"),
    ]})[0]
    second = _new_stats()
    await svc.fetch_and_upsert_master(m.id, "sh600519", detail, second)
    await session.commit()

    stored = await _div_rows(session, m.id)
    assert len(stored) == 1
    assert stored[0].ex_dividend_date == date(cur - 1, 6, 10)
    assert stored[0].dividend_label == "股改分红"
    assert second["collision"] == 0
    assert second["upd"] == 1


@pytest.mark.asyncio
async def test_collision_guard_exempt_null_label_is_backfilled(session):
    """护栏豁免 #14：存量 dividend_label=NULL 行 → 标签被补写，collision==0。"""
    m = await _add_master(session)
    _notice, detail = await _seed_sources(session)
    cur = _cur_year()
    # 预置存量行（迁移后存量 NULL 行）：同唯一键，dividend_label=None
    session.add(SecurityDividend(
        master_id=m.id, report_year=cur - 1, report_quarter=4,
        period_type=ReportPeriodType.OTHER, cash_per_share=Decimal("1.0"),
        status=DividendStatus.PROPOSED, source="巨潮-历史分红",
        dividend_label=None,
    ))
    await session.commit()

    svc = DividendNoticeScanService(session)
    rows = [_cn_row(
        report=f"{cur - 1}年报", ptype="股改分红", cash="10", ex=f"{cur - 1}-06-10",
    )]
    svc._mds.call_interface_raw = _make_raw({"600519": rows})[0]
    stats = _new_stats()
    await svc.fetch_and_upsert_master(m.id, "sh600519", detail, stats)
    await session.commit()

    stored = await _div_rows(session, m.id)
    assert len(stored) == 1
    assert stored[0].dividend_label == "股改分红"  # 被补写
    assert stats["collision"] == 0
    assert stats["upd"] == 1


# ───────────── 摘要片段 / WARN 聚合 / 唯一键 / 键集（批次 A 收口守护） ─────────────
@pytest.mark.asyncio
async def test_scan_summary_includes_new_bucket_fragments(session, monkeypatch):
    """运维对账：scan() 摘要须含四个新桶片段（无派息/无报告期/未知标签/标签撞键）。

    新桶的全部意义是运维可观测，而摘要字符串是运维唯一可见面——改了摘要却零用例守护
    等于计数器白加；此用例锁死四段格式（含计数），任一桶被删/改名即红。
    """
    m = await _add_master(session)
    _notice, _detail = await _seed_sources(session)
    cur = _cur_year()
    mid = m.id  # 纯字符串：避免 rollback 后读 ORM 属性触发同步惰性加载
    # 预置同格 (cur-1, Q4, ANNUAL) 但旧标签≠新标签 → 触发撞键护栏
    session.add(SecurityDividend(
        master_id=mid, report_year=cur - 1, report_quarter=4,
        period_type=ReportPeriodType.ANNUAL, cash_per_share=Decimal("19.0"),
        status=DividendStatus.PAID, ex_dividend_date=date(cur - 1, 6, 1),
        source="巨潮-历史分红", dividend_label="旧标签-临",
    ))
    await session.commit()
    notice_rows = [{"代码": "600519", "公告标题": "XX公司2025年度权益分派实施公告"}]
    # 年度分红(cur-1) → 同格撞键；未知类型(cur-1) → 未知标签；现金0 → 无派息
    fake, _calls = _make_raw({
        "600519": [
            _cn_row(report=f"{cur - 1}年报", cash="10", ptype="未知道具分红"),
            _cn_row(report=f"{cur - 1}年报", cash="10"),  # 年度分红 → dividend_label=年度分红 ≠ 旧标签
            _cn_row(report=f"{cur - 1}年报", cash="0"),   # 无派息
        ]
    }, notice_rows)
    monkeypatch.setattr(MarketDataSyncService, "call_interface_raw", fake)

    result = await DividendNoticeScanService(session).scan(None)
    await session.commit()

    for frag in ("无派息1", "无报告期0", "待划分0", "未知标签1", "标签撞键1"):
        assert frag in result, f"scan() 摘要须含「{frag}」（运维对账）：{result}"


@pytest.mark.asyncio
async def test_scan_aggregated_and_collision_warnings(session, monkeypatch, caplog):
    """R3：scan 整轮仅打**一条**未收录标签聚合 WARNING；撞键打一条 WARNING（pin 模块 logger）。

    不直读私有属性 ``_unknown_label_counts``，只经公共入口 scan() + caplog 验证；
    root + 模块 logger 都 pin 到 WARNING，避免被会话内其它用例的 logger 级别污染。
    """
    import logging
    caplog.set_level(logging.WARNING)
    caplog.set_level(logging.WARNING, logger="app.services.dividend_notice_scan")
    m = await _add_master(session)
    _notice, _detail = await _seed_sources(session)
    cur = _cur_year()
    mid = m.id
    session.add(SecurityDividend(
        master_id=mid, report_year=cur - 1, report_quarter=4,
        period_type=ReportPeriodType.ANNUAL, cash_per_share=Decimal("19.0"),
        status=DividendStatus.PAID, ex_dividend_date=date(cur - 1, 6, 1),
        source="巨潮-历史分红", dividend_label="旧标签-临",
    ))
    await session.commit()
    notice_rows = [{"代码": "600519", "公告标题": "XX公司2025年度权益分派实施公告"}]
    fake, _calls = _make_raw({
        "600519": [
            _cn_row(report=f"{cur - 1}年报", cash="10", ptype="未知道具分红"),  # 未知标签
            _cn_row(report=f"{cur - 1}年报", cash="10"),                        # 撞键
        ]
    }, notice_rows)
    monkeypatch.setattr(MarketDataSyncService, "call_interface_raw", fake)

    await DividendNoticeScanService(session).scan(None)
    await session.commit()

    msgs = [r.message for r in caplog.records]
    assert any("未收录标签" in x for x in msgs), f"scan 应聚合打一条未收录标签 WARNING：{msgs}"
    assert any("撞键保留旧值" in x for x in msgs), f"scan 应打一条撞键 WARNING：{msgs}"
    # 聚合未收录标签 WARNING 必须只出现一次（即非逐行 WARN 风暴）
    assert sum("未收录标签" in x for x in msgs) == 1


@pytest.mark.asyncio
async def test_security_dividends_unique_key_has_four_columns(session):
    """R4：唯一键 uq_security_dividends_master_period 须为 4 列，dividend_label 不入唯一键。

    否则同格不同标签的行会被唯一键拒绝而非走撞键护栏 → 撞键判据失效。
    """
    from sqlalchemy import text
    rows = (
        await session.execute(text(
            "SELECT kcu.column_name FROM information_schema.table_constraints tc "
            "JOIN information_schema.key_column_usage kcu "
            "ON tc.constraint_name = kcu.constraint_name "
            "WHERE tc.table_name = 'security_dividends' "
            "AND tc.constraint_type = 'UNIQUE' "
            "AND tc.constraint_name = 'uq_security_dividends_master_period' "
            "ORDER BY kcu.ordinal_position"
        ))
    ).all()
    cols = {r[0] for r in rows}
    assert cols == {"master_id", "report_year", "report_quarter", "period_type"}, (
        f"唯一键列集须为 4 列且不含 dividend_label：{cols}"
    )


@pytest.mark.asyncio
async def test_scan_and_seed_stats_keysets_equal(session):
    """R5：scan() 与 seed() 初始 stats 键集合必须完全相等，防单侧加键导致摘要缺桶。"""
    from app.services.dividend_notice_scan import _STATS_KEYS as SCAN_KEYS
    from app.services.dividend_seed import _STATS_KEYS as SEED_KEYS
    assert set(SCAN_KEYS) == set(SEED_KEYS), (
        "两入口 stats 键集必须一致，否则某一入口的摘要会缺桶"
    )
    # 新桶必须都在键集中（旧链路没有、批次 A/B 新增的可观测维度）
    for required in ("unknown_label", "collision", "no_period", "skip", "staged"):
        assert required in SCAN_KEYS


@pytest.mark.asyncio
async def test_scan_single_failure_logs_warning_with_exc_info(session, monkeypatch, caplog):
    """行动项 8：单只失败必须打 WARNING 且带 ``exc_info=True``（否则事后无法自证失败原因）。

    pin 模块 logger（``app.services.dividend_notice_scan``），避免 root 跨测试污染。
    注入方式：把 ``fetch_and_upsert_master`` 换成「仅对一只抛 RuntimeError、其余照常」的
    替身，驱动 scan 走单证券 ``except`` 分支。失败数（1）刻意 **< 总数（3）的 50%**，以免
    触发批次 E 新增的「失败占比过高抛错」阈值（该阈值另有独立用例守护）。
    """
    import logging
    caplog.set_level(logging.WARNING)
    caplog.set_level(logging.WARNING, logger="app.services.dividend_notice_scan")
    a = await _add_master(session, code="600519", name="证券A")
    await _add_master(session, code="000001", name="证券B")
    await _add_master(session, code="000002", name="证券C")
    _notice, _detail = await _seed_sources(session)
    code_a = a.code  # 失败路径 rollback 会 expire ORM 实例，先取纯字符串
    await session.commit()
    notice_rows = [
        {"代码": "600519", "公告标题": "XX公司2025年度权益分派实施公告"},
        {"代码": "000001", "公告标题": "XX公司2025年度权益分派实施公告"},
        {"代码": "000002", "公告标题": "XX公司2025年度权益分派实施公告"},
    ]
    fake, _calls = _make_raw({}, notice_rows)
    monkeypatch.setattr(MarketDataSyncService, "call_interface_raw", fake)

    original = DividendNoticeScanService.fetch_and_upsert_master

    async def _flaky(self, mid, code, detail, stats, retention_years=None):
        if code == code_a:  # 仅 A 失败（1/3 < 50%，不触发失败占比阈值）
            raise RuntimeError("boom")
        return await original(self, mid, code, detail, stats, retention_years)

    monkeypatch.setattr(DividendNoticeScanService, "fetch_and_upsert_master", _flaky)

    result = await DividendNoticeScanService(session).scan(None)
    await session.commit()

    recs = [
        r for r in caplog.records
        if r.name == "app.services.dividend_notice_scan" and "单只失败" in r.getMessage()
    ]
    assert recs, f"scan 单只失败须打 WARNING：{[r.getMessage() for r in caplog.records]}"
    assert any(r.exc_info is not None for r in recs), "warning 须带 exc_info=True（含异常栈）"
    assert "失败1只" in result


@pytest.mark.asyncio
async def test_scan_aborts_when_failure_ratio_over_half(session, monkeypatch):
    """行动项 8（§6.2）：整轮失败占比 > 50% → 冒泡（使 scheduler 记 FAILED）。

    最危险的失败模式是「上游整体失效把上万只吞成 skipped、摘要仍报完成」；只要半数以上
    证券采集失败，就判定为上游整体不可用并终止，而非静默返回「成功」摘要。
    """
    # 两只证券（全失败 → 2/2 = 100%）；scan 抛错后会话已 rollback，勿再读 ORM 属性
    await _add_master(session, code="600519", name="证券A")
    await _add_master(session, code="000001", name="证券B")
    _notice, _detail = await _seed_sources(session)
    await session.commit()
    notice_rows = [
        {"代码": "600519", "公告标题": "XX公司2025年度权益分派实施公告"},
        {"代码": "000001", "公告标题": "XX公司2025年度权益分派实施公告"},
    ]
    fake, _calls = _make_raw({}, notice_rows)
    monkeypatch.setattr(MarketDataSyncService, "call_interface_raw", fake)

    async def _boom(self, mid, code, detail, stats, retention_years=None):  # 两只全失败 → 2/2 = 100%
        raise RuntimeError("上游整体失效（模拟）")

    monkeypatch.setattr(DividendNoticeScanService, "fetch_and_upsert_master", _boom)

    with pytest.raises(RuntimeError, match="失败占比过高"):
        await DividendNoticeScanService(session).scan(None)


@pytest.mark.asyncio
async def test_scan_no_abort_when_failure_ratio_at_half(session, monkeypatch):
    """行动项 8（§6.2 边界）：失败占比 == 50% 时**不**冒泡（阈值为严格 ``> 0.5``）→ 摘要正常。

    逐只容错仍生效：半数失败（偶发）按「滚回续下一只」处理，只有**超过**半数才判整体失效。
    """
    a = await _add_master(session, code="600519", name="证券A")
    await _add_master(session, code="000001", name="证券B")
    _notice, _detail = await _seed_sources(session)
    code_a = a.code
    await session.commit()
    notice_rows = [
        {"代码": "600519", "公告标题": "XX公司2025年度权益分派实施公告"},
        {"代码": "000001", "公告标题": "XX公司2025年度权益分派实施公告"},
    ]
    fake, _calls = _make_raw({}, notice_rows)
    monkeypatch.setattr(MarketDataSyncService, "call_interface_raw", fake)

    original = DividendNoticeScanService.fetch_and_upsert_master

    async def _flaky(self, mid, code, detail, stats, retention_years=None):
        if code == code_a:  # 1/2 = 50%，恰不触发（> 0.5 才抛）
            raise RuntimeError("单只失败（模拟）")
        return await original(self, mid, code, detail, stats, retention_years)

    monkeypatch.setattr(DividendNoticeScanService, "fetch_and_upsert_master", _flaky)

    result = await DividendNoticeScanService(session).scan(None)
    await session.commit()
    assert "失败1只" in result and "失败2只" not in result
