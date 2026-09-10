"""公告扫描与特别分红补充服务单测（mock 网络层，不触真实新浪/东财）。

守护 §6.8 / 附录 A.7（公告分类与召回率）/ A.10（候选触发词）/ A.6（SPECIAL 双向去重）
与决策 A11。聚焦标题正则二筛候选词、SPECIAL 西向去重、PROPOSED→PAID、取消置 REJECTED、
SPECIAL 落格锚点。
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
)
from app.models.enums import DividendStatus, ReportPeriodType, SecurityType
from app.services.dividend_notice_scan import (
    DividendNoticeScanService,
    _TITLE_CANCEL_RE,
    _TITLE_DIVIDEND_RE,
    _TITLE_SPECIAL_RE,
    _anchor,
    _sina_cash,
)
from app.services.market_data_sync import NOTICE_CAT_ID, infer_exchange, _normalize_master_code


def _uid() -> str:
    return str(uuid.uuid4())


async def _add_master(session, code="600519"):
    norm = _normalize_master_code(code, infer_exchange(code))
    m = Security(id=_uid(), code=norm, name="贵州茅台", exchange="SH", asset_class=SecurityType.STOCK)
    session.add(m)
    await session.flush()
    return m


def _special(master_id, cash, status=DividendStatus.PROPOSED, ry=None, rq=None,
             ex=None, ann=None):
    return SecurityDividend(
        master_id=master_id,
        report_year=ry or today_app_tz().year,
        report_quarter=rq or 1,
        period_type=ReportPeriodType.SPECIAL,
        cash_per_share=Decimal(cash),
        status=status,
        ex_dividend_date=ex,
        announcement_date=ann,
        source="公告扫描",
    )


# ───────────────────────── 标题正则二筛候选词（§6.8 / 附录 A.7 / A.10） ─────────────────────────
def test_title_dividend_regex_keywords():
    """守护附录 A.7：分红相关关键词收全 `分红|派息|权益分派|利润分配|分配方案`。"""
    assert _TITLE_DIVIDEND_RE.search("贵州茅台2022年度回报股东特别分红实施公告")
    assert _TITLE_DIVIDEND_RE.search("2024年中期权益分派实施公告")
    assert _TITLE_DIVIDEND_RE.search("公司20xx年度利润分配方案公告")
    assert _TITLE_DIVIDEND_RE.search("派息公告")
    assert _TITLE_DIVIDEND_RE.search("权益分派实施公告")


def test_title_candidate_special_regex():
    """守护决策 A11 / 附录 A.10：候选特别分红须再含 `特别|中期`。"""
    moutai = "贵州茅台2022年度回报股东特别分红实施公告"
    assert _TITLE_SPECIAL_RE.search(moutai)  # 命中"特别" → 候选
    assert _TITLE_DIVIDEND_RE.search(moutai)
    kai_neng = "关于特别分红权益分派实施公告"
    assert _TITLE_SPECIAL_RE.search(kai_neng)
    # 纯年度权益分派：命中分红词但不含特别|中期 → 不触发候选补充
    plain = "XX公司2025年度权益分派实施公告"
    assert _TITLE_DIVIDEND_RE.search(plain)
    assert not _TITLE_SPECIAL_RE.search(plain)


def test_title_cancel_regex():
    """守护附录 A.10 / §6.8：`取消|终止` 落在分红相关标题上 → cancel。"""
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
    stats = {"rows": 0, "hits": 0, "special_new": 0, "special_upd": 0, "skipped": 0}
    rows = [
        {"代码": "600519", "公告标题": "贵州茅台2022年度回报股东特别分红实施公告"},  # 候选
        {"代码": "600519", "公告标题": "关于终止年度利润分配方案的公告"},          # 取消
        {"代码": "000000", "公告标题": "其他非分红公告"},                          # 未命中
    ]
    events = await svc._classify_notices(itf, rows, stats)
    assert (m.id, "candidate") in events
    assert (m.id, "cancel") in events
    assert stats["hits"] == 2


def test_anchor_comment_date_quarter():
    """守护 §2.1 决策 A6：SPECIAL 落格锚点 = 公告年 + 公告月日历季度（ceil 月/3）。"""
    assert _anchor(date(2026, 12, 14)) == (2026, 4)  # 12 月 → 2026Q4（茅台周六公告实证）
    assert _anchor(date(2026, 6, 15)) == (2026, 2)
    assert _anchor(date(2026, 3, 31)) == (2026, 1)


# ───────────────────────── 西向去重（§6.8 / 附录 A.6） ─────────────────────────
@pytest.mark.asyncio
async def test_westward_dup_by_ex_date_and_identity(session):
    """守护附录 A.6：已有「ex_date 相等」或「(ry,rq,cash) 全等」→ 跳过不重复写。"""
    m = await _add_master(session)
    session.add(_special(m.id, "19.0", status=DividendStatus.PAID,
                         ry=2022, rq=4, ex=date(2022, 12, 27)))
    await session.commit()

    svc = DividendNoticeScanService(session)
    # ex_date 相等 → True
    assert await svc._westward_dup(m.id, date(2022, 12, 27), 2022, 4, Decimal("19.0")) is True
    # (ry,rq,cash) 全等 → True（即使 ex_date 不同）
    assert await svc._westward_dup(m.id, None, 2022, 4, Decimal("19.0")) is True
    # 无命中 → False
    assert await svc._westward_dup(m.id, None, 2023, 1, Decimal("1.0")) is False


# ───────────────────────── PROPOSED→PAID（§6.8） ─────────────────────────
@pytest.mark.asyncio
async def test_match_proposed_same_cash(session):
    """守护 §6.8：PROPOSED→PAID 同额匹配，取 announcement_date 最近者。"""
    m = await _add_master(session)
    old = _special(m.id, "19.0", status=DividendStatus.PROPOSED,
                   ry=2022, rq=4, ann=date(2022, 11, 1))
    new = _special(m.id, "19.0", status=DividendStatus.PROPOSED,
                   ry=2023, rq=1, ann=date(2022, 12, 1))
    session.add_all([old, new])
    await session.commit()

    svc = DividendNoticeScanService(session)
    matched = await svc._match_proposed(m.id, Decimal("19.0"))
    assert matched is not None
    assert matched.id == new.id  # 最近公告日优先


# ───────────────────────── 取消 → REJECTED（附录 A.6 双向去重） ─────────────────────────
@pytest.mark.asyncio
async def test_process_master_cancel_rejects(session):
    """守护 §6.8：取消/终止把存量 PROPOSED SPECIAL 置 REJECTED。"""
    m = await _add_master(session)
    sp = _special(m.id, "19.0", status=DividendStatus.PROPOSED)
    session.add(sp)
    await session.commit()

    svc = DividendNoticeScanService(session)
    stats = {"hits": 0, "special_new": 0, "special_upd": 0, "skipped": 0}
    changed = await svc._process_master(
        m.id, m.code, detail=None, is_candidate=False, is_cancel=True,
        day=today_app_tz(), stats=stats,
    )
    await session.commit()
    await session.refresh(sp)
    assert sp.status == DividendStatus.REJECTED
    assert stats["special_upd"] == 1
    assert m.id in changed


# ───────────────────────── 新浪实施行 → PROPOSED→PAID（附录 A.6 / §6.8） ─────────────────────────
@pytest.mark.asyncio
async def test_process_master_sina_impl_matches_proposed(session):
    """守护 §6.8：新浪「实施」行与存量 PROPOSED 同额 → 更新为 PAID + 填补除权日。"""
    m = await _add_master(session)
    sp = _special(m.id, "19.0", status=DividendStatus.PROPOSED, ann=date(2022, 12, 1))
    session.add(sp)
    await session.commit()

    svc = DividendNoticeScanService(session)
    stats = {"hits": 0, "special_new": 0, "special_upd": 0, "skipped": 0}

    async def _fake_sina(itf, params, codes):
        return [
            {"公告日期": "2022-12-15", "派息": "190", "进度": "实施", "除权除息日": "2022-12-27"},
        ]

    svc._mds.call_interface_raw = _fake_sina
    detail = QuoteInterface(id=_uid(), provider_id=_uid(), category_id="3", name="新浪", enabled=True)
    changed = await svc._process_master(
        m.id, m.code, detail=detail, is_candidate=False, is_cancel=False,
        day=today_app_tz(), stats=stats,
    )
    await session.commit()
    await session.refresh(sp)
    assert sp.status == DividendStatus.PAID
    assert sp.ex_dividend_date == date(2022, 12, 27)
    assert sp.announcement_date == date(2022, 12, 15)
    assert sp.cash_per_share == Decimal("19.0")
    assert stats["special_upd"] == 1
    assert m.id in changed


@pytest.mark.asyncio
async def test_process_master_sina_candidate_new_special(session):
    """守护 §6.8：公告候选命中 + 新浪金额 → 写新 PROPOSED SPECIAL（公告日锚点落格）。"""
    m = await _add_master(session)
    await session.commit()

    svc = DividendNoticeScanService(session)
    stats = {"hits": 0, "special_new": 0, "special_upd": 0, "skipped": 0}

    async def _fake_sina(itf, params, codes):
        return [{"公告日期": "2022-12-14", "派息": "219.1", "进度": "预案", "除权除息日": ""}]

    svc._mds.call_interface_raw = _fake_sina
    detail = QuoteInterface(id=_uid(), provider_id=_uid(), category_id="3", name="新浪", enabled=True)
    day = date(2022, 12, 14)
    changed = await svc._process_master(
        m.id, m.code, detail=detail, is_candidate=True, is_cancel=False, day=day, stats=stats,
    )
    await session.commit()
    rows = (
        await session.execute(
            select(SecurityDividend).where(SecurityDividend.master_id == m.id)
        )
    ).scalars().all()
    assert len(rows) == 1
    row = rows[0]
    assert row.period_type == ReportPeriodType.SPECIAL
    assert row.status == DividendStatus.PROPOSED
    assert row.report_year == 2022 and row.report_quarter == 4  # 12-14 落 Q4 格
    assert row.cash_per_share == Decimal("21.91")
    assert stats["special_new"] == 1
    assert m.id in changed


def test_sina_cash_divide_by_ten():
    """守护附录 A.8：新浪 '派息'（每 10 股派 X 元）→ 每股（÷10）。"""
    assert _sina_cash("219.1") == Decimal("21.91")
    assert _sina_cash("-") is None
    assert _sina_cash(None) is None
    assert _sina_cash("nan") is None


def test_sina_cash_nan_is_missing():
    """守护 §3.5 / 迁移 0010：新浪 '派息' 返回 "NaN" → 归一为 None，不落库。

    既有 ``test_sina_cash_divide_by_ten`` 只覆盖**小写** ``"nan"``（旧代码白名单
    ``(..., "nan", ...)`` 已能拦）；本用例补**大写** ``"NaN"`` 与浮点 nan 形态——
    这两类旧代码拦不住（白名单字面量不匹配），是 ``_sina_cash`` 新增 ``is_nan()``
    分支真正修复的形态，须有护栏防回退。
    """
    assert _sina_cash("NaN") is None
    assert _sina_cash("NAN") is None
    assert _sina_cash(float("nan")) is None
    # 反例：有效值不被误伤
    assert _sina_cash("219.1") == Decimal("21.91")


# ───────────────────────── 公告源解析（§5.4 可配置化 / §6.8 接线） ─────────────────────────
async def _seed_cat4(session, *, priority=1, enabled=True, name="沪深京 A 股公告", provider_enabled=True):
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
        id=_uid(), announcement_source_interface_id=itf.id, green_threshold=0.05, red_threshold=0.03,
    ))
    await session.commit()
    svc = DividendNoticeScanService(session)
    resolved = await svc._resolve_notice_itf(await svc._settings())
    assert resolved.id == itf.id


@pytest.mark.asyncio
async def test_resolve_notice_itf_configured_disabled_fails_closed(session):
    """守护 §5.4 fail closed：配置的公告源已停用 → fail fast raise，不静默回退分类 4 其他接口。"""
    itf = await _seed_cat4(session, enabled=False)
    await _seed_cat4(session, priority=1, name="备用公告接口")  # 若静默回退会选中它
    session.add(DividendYieldSettings(
        id=_uid(), announcement_source_interface_id=itf.id, green_threshold=0.05, red_threshold=0.03,
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
    """守护 ADR-002 #1 口径：配置的公告源接口 enabled 但**提供方**已停用 → fail fast，
    不静默回退（所有选源路径须过滤提供方 enabled，否则停用提供方被照常选用）。"""
    itf = await _seed_cat4(session, provider_enabled=False)
    await _seed_cat4(session, priority=1, name="备用公告接口")  # 若静默回退会选中它
    session.add(DividendYieldSettings(
        id=_uid(), announcement_source_interface_id=itf.id, green_threshold=0.05, red_threshold=0.03,
    ))
    await session.commit()
    svc = DividendNoticeScanService(session)
    with pytest.raises(RuntimeError, match="已停用"):
        await svc._resolve_notice_itf(await svc._settings())


@pytest.mark.asyncio
async def test_resolve_detail_itf_provider_disabled_returns_none(session):
    """补充源同口径：接口 enabled 但提供方停用 → 返回 None（记告警跳过，不逐只调用）。"""
    itf = await _seed_cat4(session, provider_enabled=False)
    session.add(DividendYieldSettings(
        id=_uid(), dividend_detail_source_interface_id=itf.id, green_threshold=0.05, red_threshold=0.03,
    ))
    await session.commit()
    svc = DividendNoticeScanService(session)
    resolved = await svc._resolve_detail_itf(await svc._settings())
    assert resolved is None