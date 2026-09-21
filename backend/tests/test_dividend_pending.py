"""待划分分红 staging 单测（批次 B，§3.6 / §3.7）。

覆盖本轮落地的最小面：
- staging 幂等：同 fingerprint 重复写不新增（第二次返回 False，表内仍 1 行）；
- ``no_period``（现金 >0 且报告时间不可解析）行**入队**，``staged`` 计数 +1；
- ``no_cash``（纯送转）行**不入队**；
- 窗口外行**不入队**（可解析报告期但 ``report_year < cur-4``）；
- fingerprint 稳定性：同输入同输出 / 异字段异输出。

驱动分两层：``stage_pending`` 直调（幂等）+ ``fetch_and_upsert_master`` 端到端（分桶口径）。
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
    SecurityDividendPending,
)
from app.models.enums import SecurityType
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
    PendingDividendRow,
    parse_pending_row,
    pending_fingerprint,
)
from app.services.dividend_notice_scan import DividendNoticeScanService
from app.services.dividend_pending import stage_pending
from app.services.market_data_sync import (
    DIVIDEND_LIST_CAT_ID,
    _normalize_master_code,
    infer_exchange,
)


def _uid() -> str:
    return str(uuid.uuid4())


def _cur_year() -> int:
    return today_app_tz().year


def _cn_row(*, report, ptype="年度分红", cash="100", bonus="", convert="",
            ex="", record="", ann="", pay="") -> dict:
    """构造巨潮 ``stock_dividend_cninfo`` 响应行（11 列；金额列为「每 10 股」口径）。"""
    return {
        COL_ANN: ann,
        COL_PERIOD_TYPE: ptype,
        COL_CONVERT: convert,
        COL_BONUS: bonus,
        COL_CASH: cash,
        COL_RECORD: record,
        COL_EX: ex,
        COL_PAY: pay,
        COL_ARRIVE: "",
        COL_DESC: "10派10元",
        COL_REPORT: report,
    }


async def _add_master(session, code="600519", name="贵州茅台") -> Security:
    norm = _normalize_master_code(code, infer_exchange(code))
    m = Security(
        id=_uid(), code=norm, name=name, exchange="SH", asset_class=SecurityType.STOCK,
    )
    session.add(m)
    await session.flush()
    return m


async def _seed_detail_source(session) -> QuoteInterface:
    """建分类 3 明细源 + 提供方 + 全局设置指向它（staging 需经 fetch_and_upsert_master）。"""
    if await session.get(InterfaceCategory, DIVIDEND_LIST_CAT_ID) is None:
        session.add(InterfaceCategory(id=DIVIDEND_LIST_CAT_ID, label="股息列表", system=True))
    provider = SecuritiesDataProvider(
        id=_uid(), name="akshare", access_method="sdk", config={}, enabled=True,
    )
    session.add(provider)
    await session.flush()
    detail = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=DIVIDEND_LIST_CAT_ID,
        name="巨潮-历史分红", endpoint="stock_dividend_cninfo", enabled=True, priority=1,
        params={"symbol": "000000"},
    )
    session.add(detail)
    await session.flush()
    session.add(DividendYieldSettings(
        id=_uid(), dividend_detail_source_interface_id=detail.id,
    ))
    await session.commit()
    return detail


def _make_raw(detail_rows=None):
    """构造 ``call_interface_raw`` 替身：按 ``params["symbol"]`` 逐只返回明细行副本。"""
    detail_rows = detail_rows or {}

    async def _fake(*args):
        _itf, params = args[-3], args[-2]
        params = dict(params or {})
        return [dict(r) for r in detail_rows.get(str(params.get("symbol")), [])]

    return _fake


async def _pending_rows(session, master_id) -> list[SecurityDividendPending]:
    return (
        await session.execute(
            select(SecurityDividendPending)
            .where(SecurityDividendPending.master_id == master_id)
            .order_by(SecurityDividendPending.created_at)
        )
    ).scalars().all()


def _new_stats() -> dict:
    """与 scan()/seed() 同键集的计数器（含批次 B 的 staged 桶）。"""
    return {
        "rows": 0, "hits": 0, "new": 0, "upd": 0, "anchor": 0,
        "skip": 0, "no_period": 0, "unknown_label": 0, "collision": 0,
        "window": 0, "skipped": 0, "staged": 0,
    }


# ───────────── §3.7 staging 幂等 ─────────────
@pytest.mark.asyncio
async def test_stage_pending_idempotent_same_fingerprint(session):
    """同 fingerprint 重复写：首次 True、再次 False，表内仍仅 1 行（ON CONFLICT DO NOTHING）。"""
    m = await _add_master(session)
    await session.commit()
    mid = m.id  # 纯字符串：避免 rollback expire
    row = parse_pending_row(_cn_row(report="", cash="100"))

    first = await stage_pending(session, mid, row)
    await session.commit()
    second = await stage_pending(session, mid, row)
    await session.commit()

    assert first is True
    assert second is False
    stored = await _pending_rows(session, mid)
    assert len(stored) == 1
    assert stored[0].status.value == "PENDING"


@pytest.mark.asyncio
async def test_stage_pending_different_master_new_row(session):
    """同源行归属不同证券 → fingerprint 不同 → 各自入队一行（master_id 纳入指纹）。"""
    a = await _add_master(session, code="600519", name="证券A")
    b = await _add_master(session, code="000001", name="证券B")
    mid_a, mid_b = a.id, b.id
    await session.commit()
    row = parse_pending_row(_cn_row(report="", cash="100"))

    assert await stage_pending(session, mid_a, row) is True
    assert await stage_pending(session, mid_b, row) is True
    await session.commit()

    assert len(await _pending_rows(session, mid_a)) == 1
    assert len(await _pending_rows(session, mid_b)) == 1


# ───────────── §3.6 fingerprint 稳定性 ─────────────
def test_pending_fingerprint_stable_same_input():
    """同输入 → 同输出（sha1 hex 40 字符）。"""
    row1 = parse_pending_row(_cn_row(
        report="2025一季报", cash="100", bonus="3", convert="5",
        ex="2025-06-10", record="2025-06-09", ann="2025-05-20", pay="2025-06-20",
    ))
    row2 = parse_pending_row(_cn_row(
        report="2025一季报", cash="100", bonus="3", convert="5",
        ex="2025-06-10", record="2025-06-09", ann="2025-05-20", pay="2025-06-20",
    ))
    fp = pending_fingerprint("mid-A", row1)
    assert fp == pending_fingerprint("mid-A", row2)
    assert len(fp) == 40


def test_pending_fingerprint_changes_on_any_field():
    """异字段 → 异输出：逐字段变动（含 master_id）都会改变指纹。"""
    base = parse_pending_row(_cn_row(
        report="2025一季报", cash="100", bonus="3", convert="5",
        ex="2025-06-10", record="2025-06-09", ann="2025-05-20", pay="2025-06-20",
    ))
    base_fp = pending_fingerprint("mid-A", base)

    variants = [
        ("mid-B", base),  # master_id 变
        ("mid-A", parse_pending_row(_cn_row(
            report="2025一季报", cash="200", bonus="3", convert="5",
            ex="2025-06-10", record="2025-06-09", ann="2025-05-20", pay="2025-06-20"))),
        ("mid-A", parse_pending_row(_cn_row(
            report="2025一季报", cash="100", bonus="4", convert="5",
            ex="2025-06-10", record="2025-06-09", ann="2025-05-20", pay="2025-06-20"))),
        ("mid-A", parse_pending_row(_cn_row(
            report="2025一季报", cash="100", bonus="3", convert="5",
            ex="2025-07-10", record="2025-06-09", ann="2025-05-20", pay="2025-06-20"))),
        ("mid-A", parse_pending_row(_cn_row(
            report="2025三季报", cash="100", bonus="3", convert="5",
            ex="2025-06-10", record="2025-06-09", ann="2025-05-20", pay="2025-06-20"))),
        # 以下逐字段：转增 / 原文标签 / 股权登记日 / 派息日 / 公告日
        # （后三者是 QA 指出原用例漏测的日期列，必须参与指纹，否则拦不住回归）
        ("mid-A", parse_pending_row(_cn_row(
            report="2025一季报", cash="100", bonus="3", convert="6",
            ex="2025-06-10", record="2025-06-09", ann="2025-05-20", pay="2025-06-20"))),
        ("mid-A", parse_pending_row(_cn_row(
            report="2025一季报", ptype="中期分红", cash="100", bonus="3", convert="5",
            ex="2025-06-10", record="2025-06-09", ann="2025-05-20", pay="2025-06-20"))),
        ("mid-A", parse_pending_row(_cn_row(
            report="2025一季报", cash="100", bonus="3", convert="5",
            ex="2025-06-10", record="2025-06-08", ann="2025-05-20", pay="2025-06-20"))),
        ("mid-A", parse_pending_row(_cn_row(
            report="2025一季报", cash="100", bonus="3", convert="5",
            ex="2025-06-10", record="2025-06-09", ann="2025-05-20", pay="2025-06-21"))),
        ("mid-A", parse_pending_row(_cn_row(
            report="2025一季报", cash="100", bonus="3", convert="5",
            ex="2025-06-10", record="2025-06-09", ann="2025-05-21", pay="2025-06-20"))),
    ]
    for mid, row in variants:
        assert pending_fingerprint(mid, row) != base_fp


def test_parse_pending_row_maps_all_columns():
    """§3.1：parse_pending_row 取全字段（÷10 每股、日期解析、原文标签/报告时间原样）。"""
    row = parse_pending_row(_cn_row(
        report="未知报告期", ptype="股改分红", cash="219.1", bonus="3", convert="5",
        ex="2025-06-10", record="2025-06-09", ann="2025-05-20", pay="2025-06-20",
    ))
    assert row.dividend_label == "股改分红"
    assert row.cash_per_share == Decimal("21.91")
    assert row.bonus_share_ratio == Decimal("0.3")
    assert row.convert_ratio == Decimal("0.5")
    assert row.ex_dividend_date == date(2025, 6, 10)
    assert row.record_date == date(2025, 6, 9)
    assert row.pay_date == date(2025, 6, 20)
    assert row.announcement_date == date(2025, 5, 20)
    assert row.report_period_raw == "未知报告期"
    assert set(row.fields()) == {
        "dividend_label", "cash_per_share", "bonus_share_ratio", "convert_ratio",
        "record_date", "ex_dividend_date", "pay_date", "announcement_date",
        "report_period_raw",
    }


# ───────────── §9.2 入队 / 不入队分桶（端到端经 fetch_and_upsert_master） ─────────────
@pytest.mark.asyncio
async def test_no_period_cash_row_is_staged(session):
    """现金 >0 且报告时间不可解析 → 入队，``staged`` 计数 +1，``no_period`` 计 1。"""
    m = await _add_master(session)
    _detail = await _seed_detail_source(session)
    mid, code = m.id, m.code
    svc = DividendNoticeScanService(session)
    svc._mds.call_interface_raw = _make_raw(
        {"600519": [_cn_row(report="", cash="100")]}
    )
    stats = _new_stats()
    await svc.fetch_and_upsert_master(mid, code, _detail, stats)
    await session.commit()

    assert stats["staged"] == 1
    assert stats["no_period"] == 1
    rows = await _pending_rows(session, mid)
    assert len(rows) == 1
    assert rows[0].cash_per_share == Decimal("10.0")


@pytest.mark.asyncio
async def test_no_cash_row_is_not_staged(session):
    """纯送转（现金 0/空）→ 计入 ``skip``，**不入队**（staged=0，无 pending 行）。"""
    m = await _add_master(session)
    _detail = await _seed_detail_source(session)
    mid, code = m.id, m.code
    svc = DividendNoticeScanService(session)
    svc._mds.call_interface_raw = _make_raw(
        {"600519": [_cn_row(report="", cash="", bonus="3", convert="5")]}
    )
    stats = _new_stats()
    await svc.fetch_and_upsert_master(mid, code, _detail, stats)
    await session.commit()

    assert stats["skip"] == 1
    assert stats["staged"] == 0
    assert await _pending_rows(session, mid) == []


@pytest.mark.asyncio
async def test_out_of_window_row_is_not_staged(session):
    """报告期可解析但落在留存窗外（``report_year < cur-4``）→ 计入 ``window``，不入队。"""
    m = await _add_master(session)
    _detail = await _seed_detail_source(session)
    mid, code = m.id, m.code
    svc = DividendNoticeScanService(session)
    svc._mds.call_interface_raw = _make_raw(
        {"600519": [_cn_row(report=f"{_cur_year() - 5}年报", cash="100")]}
    )
    stats = _new_stats()
    await svc.fetch_and_upsert_master(mid, code, _detail, stats)
    await session.commit()

    assert stats["window"] == 1
    assert stats["staged"] == 0
    assert await _pending_rows(session, mid) == []


@pytest.mark.asyncio
async def test_no_period_row_does_not_touch_changed(session):
    """staging 不计入主表写入：返回 False（无 ``changed``）、不写 ``security_dividends``。"""
    m = await _add_master(session)
    _detail = await _seed_detail_source(session)
    mid, code = m.id, m.code
    svc = DividendNoticeScanService(session)
    svc._mds.call_interface_raw = _make_raw(
        {"600519": [_cn_row(report="未知报告期", cash="100")]}
    )
    stats = _new_stats()
    dirty = await svc.fetch_and_upsert_master(mid, code, _detail, stats)
    await session.commit()

    assert dirty is False
    assert stats["staged"] == 1
    assert len(await _pending_rows(session, mid)) == 1


def test_pending_row_fields_excludes_service_columns():
    """``PendingDividendRow.fields()`` 只含业务列（不含 id/status/fingerprint）。"""
    row = PendingDividendRow(
        dividend_label=None, cash_per_share=Decimal("1.0"),
        bonus_share_ratio=None, convert_ratio=None, record_date=None,
        ex_dividend_date=None, pay_date=None, announcement_date=None,
        report_period_raw=None,
    )
    assert "id" not in row.fields()
    assert "status" not in row.fields()
    assert "row_fingerprint" not in row.fields()
