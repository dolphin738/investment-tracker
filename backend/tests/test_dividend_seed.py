"""首跑播种服务单测（方案 §5.7；测试处置表 §4.6 新增项）。

``DividendSeedService.seed_initial_dividends`` 是「首跑把近 5 年分过红的证券灌进来」的
独立路径——``scan()`` 只拉当天公告（每日增量），不回溯历史，故历史补齐完全依赖本模块。

覆盖（§4.6 明确列出的四项 + 本轮两条防回归护栏）：
- seed set 取**全市场**（§9.3-A4 裁决 B）；``symbol`` 为纯数字代码；
- 断点续跑：已由**当前明细源**写入近 5 年记录的 master 跳过，不浪费 rate_limit 预算；
- **旧源行不得被误判为已覆盖**（P1 才删 ``新浪-分红配股`` 存量行，此判据是播种
  「静默无产出」的唯一防线）；同理窗口外年份的当前源行也不算已覆盖；
- 单只失败 rollback 续下一只，且失败那只的计数被 snapshot 回退（摘要不虚高）；
- 真 5 年裁剪（``retention_cutoff_year`` = cur-4）端到端；
- 摘要字符串形态（运维对账）；
- 明细源缺失/停用 **不 fail fast**（与 ``scan()`` 同口径）。

**本环境已知 flaky 陷阱**：单只失败路径的 ``session.rollback()`` 会 expire 会话内
**全部** ORM 实例，此后读 ``obj.attr`` 触发同步惰性加载 → ``MissingGreenlet``，会把
「下一只也失败」误算进 stats。故所有用例一律**先取纯字符串/标量**再驱动被测逻辑。
"""
from __future__ import annotations

import uuid
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
    retention_cutoff_year,
)
from app.services.dividend_notice_scan import DividendNoticeScanService
from app.services.dividend_seed import DividendSeedService, run_dividend_seed
from app.services.market_data_sync import (
    DIVIDEND_LIST_CAT_ID,
    MarketDataSyncService,
    _normalize_master_code,
    infer_exchange,
)

# 当前明细源名（``detail.name``，同时是播种写入行的 source）
_DETAIL_NAME = "巨潮-历史分红"
# 旧新浪存量行的 source（P1 才删除；P0~P1 并存期内大量证券只有这种行）
_LEGACY_SOURCE = "新浪-分红配股"


def _uid() -> str:
    return str(uuid.uuid4())


def _cur_year() -> int:
    return today_app_tz().year


def _cutoff_year() -> int:
    """真 5 年留存窗口下界（与被测代码同源，避免测试里另写一份算术）。"""
    return retention_cutoff_year(today_app_tz())


def _digits(code: str) -> str:
    """证券代码纯数字部分（sh600519 → 600519）。"""
    return "".join(ch for ch in code if ch.isdigit())


async def _add_master(session, code: str, name: str = "证券") -> Security:
    """造一只证券主数据；返回后**立刻**取纯字符串 id/code 再用（防 rollback expire）。"""
    norm = _normalize_master_code(code, infer_exchange(code))
    m = Security(
        id=_uid(), code=norm, name=name, exchange="SH", asset_class=SecurityType.STOCK,
    )
    session.add(m)
    await session.flush()
    return m


def _cn_row(*, report, ptype="年度分红", cash="100", bonus="", convert="",
            ex="", record="", ann="") -> dict:
    """构造巨潮 ``stock_dividend_cninfo`` 响应行（11 列；金额列为「每 10 股」口径）。"""
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
        COL_DESC: "10派10元",
        COL_REPORT: report,
    }


def _div_row(master_id, cash, *, source, ry, rq=4, status=DividendStatus.PAID,
             period_type=ReportPeriodType.ANNUAL, ex=None):
    """造一行 ``security_dividends``（source 必填：本模块断点判据的核心维度）。"""
    return SecurityDividend(
        master_id=master_id,
        report_year=ry,
        report_quarter=rq,
        period_type=period_type,
        cash_per_share=Decimal(cash),
        status=status,
        ex_dividend_date=ex,
        source=source,
    )


def _make_raw(detail_rows=None):
    """构造 ``call_interface_raw`` 替身：按 ``params["symbol"]`` 逐只返回明细行。

    兼容两类替换方式（实例属性赋值 / 类级 monkeypatch）故取末三位参数；返回行副本，
    避免 upsert 就地改写用例间共享的 dict。
    """
    detail_rows = detail_rows or {}
    calls: list[tuple[object, dict]] = []

    async def _fake(*args):
        itf, params = args[-3], args[-2]
        params = dict(params or {})
        calls.append((itf, params))
        return [dict(r) for r in detail_rows.get(str(params.get("symbol")), [])]

    return _fake, calls


def _detail_calls(calls) -> list[tuple[object, dict]]:
    """过滤出分类 3（股息列表/明细源）调用，排除其它分类干扰。"""
    return [c for c in calls if getattr(c[0], "category_id", None) == DIVIDEND_LIST_CAT_ID]


def _symbols(calls) -> set[str]:
    return {str(p.get("symbol")) for _itf, p in _detail_calls(calls)}


async def _ensure_categories(session) -> None:
    if await session.get(InterfaceCategory, DIVIDEND_LIST_CAT_ID) is None:
        session.add(InterfaceCategory(id=DIVIDEND_LIST_CAT_ID, label="股息列表", system=True))
    await session.flush()


async def _seed_detail_source(session) -> QuoteInterface:
    """建分类 3 明细源 + 提供方 + 全局设置指向它；返回明细源接口。

    播种只消费明细源（不解析公告），故无需建分类 4 公告源。
    """
    await _ensure_categories(session)
    provider = SecuritiesDataProvider(
        id=_uid(), name="akshare", access_method="sdk", config={}, enabled=True,
    )
    session.add(provider)
    await session.flush()  # 提供方先落库，接口 provider_id 外键才有归属
    detail = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=DIVIDEND_LIST_CAT_ID,
        name=_DETAIL_NAME, endpoint="stock_dividend_cninfo", enabled=True, priority=1,
        params={"symbol": "000000"},
    )
    session.add(detail)
    await session.flush()
    session.add(DividendYieldSettings(
        id=_uid(), dividend_detail_source_interface_id=detail.id,
    ))
    await session.commit()
    return detail


async def _div_rows(session, master_id) -> list[SecurityDividend]:
    return (
        await session.execute(
            select(SecurityDividend)
            .where(SecurityDividend.master_id == master_id)
            .order_by(SecurityDividend.report_year, SecurityDividend.report_quarter)
        )
    ).scalars().all()


# ───────────── §9.3-A4 seed set = 全市场 ─────────────
@pytest.mark.asyncio
async def test_seed_set_is_whole_market(session, monkeypatch):
    """§9.3-A4：seed set 取 ``securities`` 全表（B 全市场），逐只调用明细源。

    断言「被调次数 == 证券数」即可刻画「全市场」——轻量子集 A / 广播种面列已被裁决不做，
    若实现退回子集，次数会小于证券数。
    """
    codes = ["600519", "000001", "300750"]
    for c in codes:
        await _add_master(session, code=c, name=f"证券{c}")
    await _seed_detail_source(session)
    await session.commit()

    fake, calls = _make_raw({})
    monkeypatch.setattr(MarketDataSyncService, "call_interface_raw", fake)

    summary = await DividendSeedService(session).seed_initial_dividends(None)
    await session.commit()

    assert len(_detail_calls(calls)) == len(codes), "每只证券都须被采集一次（全市场 seed set）"
    assert f"证券总数{len(codes)}只" in summary
    assert f"本轮处理{len(codes)}只" in summary


@pytest.mark.asyncio
async def test_seed_symbol_is_digits_only(session, monkeypatch):
    """§5.2：播种传给明细源的 ``symbol`` 是证券代码**纯数字**（sh600519 → 600519）。

    响应无代码列，证券代码只能来自调用方参数；带交易所前缀会导致巨潮查不到。
    """
    await _add_master(session, code="600519", name="贵州茅台")
    await _seed_detail_source(session)
    await session.commit()

    fake, calls = _make_raw({})
    monkeypatch.setattr(MarketDataSyncService, "call_interface_raw", fake)

    await DividendSeedService(session).seed_initial_dividends(None)
    await session.commit()

    symbols = _symbols(calls)
    assert symbols == {"600519"}
    assert all(s.isdigit() for s in symbols), "symbol 须为纯数字代码"


# ───────────── §5.7 断点续跑检查点 ─────────────
@pytest.mark.asyncio
async def test_seed_skips_master_covered_by_current_source(session, monkeypatch):
    """§5.7 断点续跑：已有「当前明细源 + 窗口内年份」行的 master 跳过，不重复消耗预算。"""
    a = await _add_master(session, code="600519", name="证券A")
    b = await _add_master(session, code="000001", name="证券B")
    await _seed_detail_source(session)
    mid_a, code_b = a.id, b.code  # 纯字符串先取，防 rollback expire
    session.add(_div_row(mid_a, "19.0", source=_DETAIL_NAME, ry=_cur_year() - 1))
    await session.commit()

    fake, calls = _make_raw({})
    monkeypatch.setattr(MarketDataSyncService, "call_interface_raw", fake)

    summary = await DividendSeedService(session).seed_initial_dividends(None)
    await session.commit()

    assert _symbols(calls) == {_digits(code_b)}, (
        "已覆盖的 A 不得再调接口；只有未覆盖的 B 被采集"
    )
    assert "已覆盖跳过1只" in summary
    assert "本轮处理1只" in summary


@pytest.mark.asyncio
async def test_seed_old_source_row_is_not_treated_as_covered(session, monkeypatch):
    """【防回归核心】只有旧新浪存量行的证券**必须**照常采集，不得被判为已覆盖。

    P1 才删旧源行（``source='新浪-分红配股'``）；P0~P1 并存期内大量**尚未播种**的证券
    在 ``security_dividends`` 里存在的恰恰只有这种行，且其 ``report_year`` 同样落在
    ``[cur-4, cur]`` 窗口内。若检查点只按年份过滤，播种会跳过几乎全部证券 → 静默无产出。
    """
    m = await _add_master(session, code="600519", name="证券A")
    await _seed_detail_source(session)
    mid, code = m.id, m.code
    session.add(_div_row(mid, "19.0", source=_LEGACY_SOURCE, ry=_cur_year() - 2))
    await session.commit()

    fake, calls = _make_raw({_digits(code): [_cn_row(report=f"{_cur_year() - 1}年报")]})
    monkeypatch.setattr(MarketDataSyncService, "call_interface_raw", fake)

    summary = await DividendSeedService(session).seed_initial_dividends(None)
    await session.commit()

    assert _symbols(calls) == {_digits(code)}, "旧源行不得让该证券被判为已完成"
    assert "已覆盖跳过0只" in summary
    # 真正被采集（不只是「调了接口」）：新链路写入的行 source 为明细源名
    stored = await _div_rows(session, mid)
    assert any(r.source == _DETAIL_NAME for r in stored), "须实写入一行当前源记录"
    assert any(r.source == _LEGACY_SOURCE for r in stored), "旧源行在 P1 前保持原样"


@pytest.mark.asyncio
async def test_seed_current_source_row_outside_window_is_not_covered(session, monkeypatch):
    """真 5 年边界：当前源行的 ``report_year`` 落在窗口**外**（< cur-4）不算已覆盖。

    否则「很久以前分过红、近 5 年数据尚未补齐」的证券会被永久跳过。
    """
    m = await _add_master(session, code="600519", name="证券A")
    await _seed_detail_source(session)
    mid, code = m.id, m.code
    session.add(_div_row(mid, "19.0", source=_DETAIL_NAME, ry=_cutoff_year() - 1))
    await session.commit()

    fake, calls = _make_raw({})
    monkeypatch.setattr(MarketDataSyncService, "call_interface_raw", fake)

    summary = await DividendSeedService(session).seed_initial_dividends(None)
    await session.commit()

    assert _symbols(calls) == {_digits(code)}, "窗口外的当前源行不构成「已覆盖」"
    assert "已覆盖跳过0只" in summary


# ───────────── §5.7 逐只容错：rollback 续下一只 ─────────────
@pytest.mark.asyncio
async def test_single_master_failure_rolls_back_and_continues(session, monkeypatch):
    """§5.7：单只失败 rollback 后继续下一只；失败数计入摘要，成功那只照常落库。"""
    a = await _add_master(session, code="600519", name="证券A")
    b = await _add_master(session, code="000001", name="证券B")
    await _seed_detail_source(session)
    # 纯字符串先取：失败路径的 rollback 会 expire 全部 ORM 实例
    mid_a, code_a, mid_b, code_b = a.id, a.code, b.id, b.code
    await session.commit()

    cur = _cur_year()
    fake, _calls = _make_raw({
        _digits(code_a): [_cn_row(report=f"{cur - 1}年报", cash="100")],
        _digits(code_b): [_cn_row(report=f"{cur - 1}年报", cash="50")],
    })
    monkeypatch.setattr(MarketDataSyncService, "call_interface_raw", fake)

    original = DividendNoticeScanService.fetch_and_upsert_master

    async def _flaky(self, mid, code, detail, stats):
        dirty = await original(self, mid, code, detail, stats)
        if code == code_a:  # A 在提交阶段失败（B 不受影响）
            raise RuntimeError("单只提交失败（模拟）")
        return dirty

    monkeypatch.setattr(DividendNoticeScanService, "fetch_and_upsert_master", _flaky)

    summary = await DividendSeedService(session).seed_initial_dividends(None)
    await session.commit()

    assert "失败1只" in summary
    assert "本轮处理1只" in summary, "失败那只不计入 hits（hits 仅在提交成功后累加）"
    assert await _div_rows(session, mid_a) == [], "A 的写入须随 rollback 丢弃"
    b_rows = await _div_rows(session, mid_b)
    assert len(b_rows) == 1 and b_rows[0].cash_per_share == Decimal("5.0")


@pytest.mark.asyncio
async def test_failure_rolls_back_stats_snapshot_not_inflated(session, monkeypatch):
    """§5.7：失败那只已累加的计数须由 snapshot 回退——摘要等于实际落库结果（不虚高）。

    A 在 ``fetch_and_upsert_master`` 之后失败：其 ``new`` 已 +1，若无 snapshot 回退，
    摘要会报「新写2」而库里只有 B 的 1 行，运维按摘要对账必然偏大。
    """
    a = await _add_master(session, code="600519", name="证券A")
    b = await _add_master(session, code="000001", name="证券B")
    await _seed_detail_source(session)
    code_a, code_b = a.code, b.code
    await session.commit()

    cur = _cur_year()
    fake, _calls = _make_raw({
        _digits(code_a): [_cn_row(report=f"{cur - 1}年报", cash="100")],
        _digits(code_b): [_cn_row(report=f"{cur - 1}年报", cash="50")],
    })
    monkeypatch.setattr(MarketDataSyncService, "call_interface_raw", fake)

    original = DividendNoticeScanService.fetch_and_upsert_master

    async def _flaky(self, mid, code, detail, stats):
        dirty = await original(self, mid, code, detail, stats)
        if code == code_a:
            raise RuntimeError("单只提交失败（模拟）")
        return dirty

    monkeypatch.setattr(DividendNoticeScanService, "fetch_and_upsert_master", _flaky)

    summary = await DividendSeedService(session).seed_initial_dividends(None)
    await session.commit()

    assert "新写1" in summary, "失败那只的 new 计数须被 snapshot 回退，只保留 B 的 1 行"
    assert "新写2" not in summary
    assert "重算1只" in summary, "变更集只含提交成功的 B"


# ───────────── §9.3-A3 真 5 年裁剪（端到端，由 fetch_and_upsert_master 承担） ─────────────
@pytest.mark.asyncio
async def test_seed_cuts_rows_outside_true_five_year_window(session, monkeypatch):
    """§9.3-A3 端到端：``report_year < cur-4`` 的行不落库，计入 ``窗口外``。

    裁剪由复用的 ``fetch_and_upsert_master`` 内部承担（播种不得另写一套解析），故此处
    只做端到端覆盖，不重复测别人的代码。
    """
    m = await _add_master(session, code="600519", name="证券A")
    await _seed_detail_source(session)
    mid, code = m.id, m.code
    await session.commit()

    cur = _cur_year()
    fake, _calls = _make_raw({_digits(code): [
        _cn_row(report=f"{_cutoff_year() - 1}年报", cash="10"),  # 窗口外
        _cn_row(report=f"{_cutoff_year()}年报", cash="20"),      # 窗口内下界
    ]})
    monkeypatch.setattr(MarketDataSyncService, "call_interface_raw", fake)

    summary = await DividendSeedService(session).seed_initial_dividends(None)
    await session.commit()

    stored = await _div_rows(session, mid)
    assert [r.report_year for r in stored] == [_cutoff_year()]
    assert "窗口外1" in summary
    assert _cutoff_year() == cur - 4, "留存窗口须为真 5 年 [cur-4, cur]（§9.3-A3）"


# ───────────── 摘要形态（运维对账） ─────────────
@pytest.mark.asyncio
async def test_seed_summary_shape(session, monkeypatch):
    """§5.7：摘要须含运维对账所需的全部片段（总数/覆盖跳过/处理/失败/新写/更新/重算）。"""
    a = await _add_master(session, code="600519", name="证券A")
    await _add_master(session, code="000001", name="证券B")
    await _seed_detail_source(session)
    code_a = a.code
    await session.commit()

    fake, _calls = _make_raw({
        _digits(code_a): [_cn_row(report=f"{_cur_year() - 1}年报", cash="100")],
    })
    monkeypatch.setattr(MarketDataSyncService, "call_interface_raw", fake)

    summary = await DividendSeedService(session).seed_initial_dividends(None)
    await session.commit()

    for frag in (
        "历史分红播种完成",
        "证券总数2只", "已覆盖跳过0只", "本轮处理2只", "失败0只",
        "新写1", "更新0", "窗口外0", "去重跳过0", "重算1只",
    ):
        assert frag in summary, f"摘要须含「{frag}」（运维对账）：{summary}"


# ───────────── 明细源缺失：不 fail fast（与 scan() 同口径） ─────────────
@pytest.mark.asyncio
async def test_seed_without_detail_source_does_not_fail_fast(session, monkeypatch):
    """明细源缺失/停用 → 不抛异常、摘要标注「明细源缺失」，且不逐只采集。

    与 ``scan():232`` 同口径：配置缺失是**运维态**而非故障，播种其余步骤（统计、重算）
    照常完成，由摘要显式告知。
    """
    for c in ("600519", "000001"):
        await _add_master(session, code=c, name=f"证券{c}")
    # 故意不建 DividendYieldSettings / 明细源接口 → detail 解析为 None
    await session.commit()

    fake, calls = _make_raw({})
    monkeypatch.setattr(MarketDataSyncService, "call_interface_raw", fake)

    summary = await DividendSeedService(session).seed_initial_dividends(None)
    await session.commit()

    assert "明细源缺失跳过逐只采集" in summary
    assert _detail_calls(calls) == [], "明细源缺失时不得发起任何采集请求"
    assert "证券总数2只" in summary


# ───────────── 模块级 handler：自建会话 ─────────────
@pytest.mark.asyncio
async def test_run_dividend_seed_returns_summary(session, monkeypatch):
    """§5.7 handler：``run_dividend_seed`` 内部自建会话执行播种并透传摘要。

    会话隔离由 conftest 的模块级 ``AsyncSessionLocal`` 重绑夹具保障（handler 在函数内
    ``from app.db.database import AsyncSessionLocal``，取到的是测试库 maker）。
    """
    await _add_master(session, code="600519", name="证券A")
    await _seed_detail_source(session)
    await session.commit()

    fake, calls = _make_raw({})
    monkeypatch.setattr(MarketDataSyncService, "call_interface_raw", fake)

    summary = await run_dividend_seed(None)

    assert isinstance(summary, str) and summary.startswith("历史分红播种完成")
    assert "证券总数1只" in summary
    assert len(_detail_calls(calls)) == 1


# ───────────── 摘要片段 / WARN 聚合（批次 A 收口守护） ─────────────
@pytest.mark.asyncio
async def test_seed_summary_includes_new_bucket_fragments(session, monkeypatch):
    """运维对账：seed() 摘要须含四个新桶片段（无派息/无报告期/未知标签/标签撞键）。

    摘要字符串是运维唯一可见面——此用例锁死四段格式（含计数），任一桶被删/改名即红。
    """
    m = await _add_master(session, code="600519", name="证券A")
    await _seed_detail_source(session)
    code = m.code  # 纯字符串先取，防 rollback expire
    await session.commit()
    cur = _cur_year()
    fake, _calls = _make_raw({_digits(code): [
        _cn_row(report=f"{cur - 1}年报", cash="10", ptype="未知道具分红"),  # 未知标签
        _cn_row(report=f"{cur - 1}年报", cash="0"),                         # 无派息
    ]})
    monkeypatch.setattr(MarketDataSyncService, "call_interface_raw", fake)

    summary = await DividendSeedService(session).seed_initial_dividends(None)
    await session.commit()

    for frag in ("无派息1", "无报告期0", "待划分0", "未知标签1", "标签撞键0"):
        assert frag in summary, f"seed() 摘要须含「{frag}」（运维对账）：{summary}"


@pytest.mark.asyncio
async def test_seed_no_period_row_is_staged(session, monkeypatch):
    """批次 B：播种路径经 ``fetch_and_upsert_master`` 同样落 staging。

    现金 >0 且报告时间不可解析 → ``staged`` 桶 +1（摘要含「待划分1」），并写入 1 行
    ``security_dividend_pending``；主表 ``security_dividends`` 仍无写入。
    """
    m = await _add_master(session, code="600519", name="证券A")
    await _seed_detail_source(session)
    mid, code = m.id, m.code  # 纯字符串先取，防 rollback expire
    await session.commit()
    fake, _calls = _make_raw({_digits(code): [_cn_row(report="", cash="100")]})
    monkeypatch.setattr(MarketDataSyncService, "call_interface_raw", fake)

    summary = await DividendSeedService(session).seed_initial_dividends(None)
    await session.commit()

    assert "待划分1" in summary
    assert await _div_rows(session, mid) == []
    pending = (
        await session.execute(
            select(SecurityDividendPending).where(SecurityDividendPending.master_id == mid)
        )
    ).scalars().all()
    assert len(pending) == 1


@pytest.mark.asyncio
async def test_seed_aggregated_unknown_label_warning(session, monkeypatch, caplog):
    """R3：seed 整轮仅打**一条**未收录标签聚合 WARNING（pin seed 模块 logger）。

    不直读私有属性 ``_unknown_label_counts``，只经公共入口 seed() + caplog 验证。
    seed 的聚合 WARNING 走 ``app.services.dividend_seed`` logger（非 scan 的），须分别 pin。
    """
    import logging
    caplog.set_level(logging.WARNING)
    caplog.set_level(logging.WARNING, logger="app.services.dividend_seed")
    m = await _add_master(session, code="600519", name="证券A")
    await _seed_detail_source(session)
    code = m.code
    await session.commit()
    cur = _cur_year()
    fake, _calls = _make_raw({_digits(code): [
        _cn_row(report=f"{cur - 1}年报", cash="10", ptype="未知道具分红"),
    ]})
    monkeypatch.setattr(MarketDataSyncService, "call_interface_raw", fake)

    await DividendSeedService(session).seed_initial_dividends(None)
    await session.commit()

    msgs = [r.message for r in caplog.records]
    assert any("未收录标签" in x for x in msgs), f"seed 应打一条未收录标签 WARNING：{msgs}"
    # 聚合未收录标签 WARNING 必须只出现一次（非逐行 WARN 风暴）
    assert sum("未收录标签" in x for x in msgs) == 1


@pytest.mark.asyncio
async def test_seed_single_failure_logs_warning_with_exc_info(session, monkeypatch, caplog):
    """行动项 8：播种单只失败必须打 WARNING 且带 ``exc_info=True``。

    走的是 ``app.services.dividend_seed`` 模块 logger（非 scan 的），须单独 pin。
    注入方式：仅对一只有效抛 RuntimeError（其余照常）。失败数（1）**< 总数（3）的 50%**，
    避免触发批次 E 新增的「失败占比过高抛错」阈值（该阈值另有独立用例守护）。
    """
    import logging
    caplog.set_level(logging.WARNING)
    caplog.set_level(logging.WARNING, logger="app.services.dividend_seed")
    a = await _add_master(session, code="600519", name="证券A")
    await _add_master(session, code="000001", name="证券B")
    await _add_master(session, code="000002", name="证券C")
    await _seed_detail_source(session)
    code_a = a.code  # 失败路径 rollback 会 expire ORM 实例，先取纯字符串
    await session.commit()
    fake, _calls = _make_raw({})
    monkeypatch.setattr(MarketDataSyncService, "call_interface_raw", fake)

    original = DividendNoticeScanService.fetch_and_upsert_master

    async def _flaky(self, mid, code, detail, stats):
        if code == code_a:  # 仅 A 失败（1/3 < 50%）
            raise RuntimeError("boom")
        return await original(self, mid, code, detail, stats)

    monkeypatch.setattr(DividendNoticeScanService, "fetch_and_upsert_master", _flaky)

    summary = await DividendSeedService(session).seed_initial_dividends(None)
    await session.commit()

    recs = [
        r for r in caplog.records
        if r.name == "app.services.dividend_seed" and "单只失败" in r.getMessage()
    ]
    assert recs, f"seed 单只失败须打 WARNING：{[r.getMessage() for r in caplog.records]}"
    assert any(r.exc_info is not None for r in recs), "warning 须带 exc_info=True（含异常栈）"
    assert "失败1只" in summary


@pytest.mark.asyncio
async def test_seed_aborts_when_failure_ratio_over_half(session, monkeypatch):
    """行动项 8（§6.2）：整轮失败占比 > 50% → 冒泡（使 scheduler 记 FAILED 而非 SUCCESS）。"""
    # seed set = 全表证券；两只全失败 → 2/2 = 100% > 50%
    await _add_master(session, code="600519", name="证券A")
    await _add_master(session, code="000001", name="证券B")
    await _seed_detail_source(session)
    await session.commit()
    fake, _calls = _make_raw({})
    monkeypatch.setattr(MarketDataSyncService, "call_interface_raw", fake)

    async def _boom(self, mid, code, detail, stats):
        raise RuntimeError("上游整体失效（模拟）")

    monkeypatch.setattr(DividendNoticeScanService, "fetch_and_upsert_master", _boom)

    with pytest.raises(RuntimeError, match="失败占比过高"):
        await DividendSeedService(session).seed_initial_dividends(None)


@pytest.mark.asyncio
async def test_seed_no_abort_when_failure_ratio_at_half(session, monkeypatch):
    """行动项 8（§6.2 边界）：失败占比 == 50% 时**不**冒泡（严格 ``> 0.5``）→ 摘要正常。"""
    a = await _add_master(session, code="600519", name="证券A")
    await _add_master(session, code="000001", name="证券B")
    await _seed_detail_source(session)
    code_a = a.code
    await session.commit()
    fake, _calls = _make_raw({})
    monkeypatch.setattr(MarketDataSyncService, "call_interface_raw", fake)

    original = DividendNoticeScanService.fetch_and_upsert_master

    async def _flaky(self, mid, code, detail, stats):
        if code == code_a:  # 1/2 = 50%，恰不触发
            raise RuntimeError("单只失败（模拟）")
        return await original(self, mid, code, detail, stats)

    monkeypatch.setattr(DividendNoticeScanService, "fetch_and_upsert_master", _flaky)

    summary = await DividendSeedService(session).seed_initial_dividends(None)
    await session.commit()
    assert "失败1只" in summary and "失败2只" not in summary
