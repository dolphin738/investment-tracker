"""待人工划分分红端点集成测试（批次 C，§4）。

覆盖：
- 鉴权矩阵：admin 全通 / auditor 只读可读、写 403 / 普通 user 读 403 / 未登录 401；
- 列表分页、筛选（status/label/q）、**固定排序** ``created_at DESC, id DESC``；
- assign 冲突路径（``conflict=True`` 且主表旧值**未被覆盖**）；
- assign 非冲突路径（写回主表，source=人工划分、status 按除权日推导）；
- 批量部分失败（``{succeeded, failed[]}`` 含 NOT_FOUND / INVALID_STATE / VALIDATION_FAILED）；
- 批量单项入库异常隔离（DB_ERROR）：一项抛错不中断整批，其余项照常处理；
- reopen 回滚（主表行被删 + ``rolledBack=True`` + pending 回 PENDING 且清 ``resolved_*``）；
- ignore（PENDING → IGNORED）与非 PENDING 状态保护。
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy import select, update

from app.core.date_utils import today_app_tz
from app.models import Security, SecurityDividend, SecurityDividendPending, User
from app.models.dividend_yield import DEFAULT_DIVIDEND_RETENTION_YEARS
from app.models.enums import (
    DividendPendingStatus,
    DividendStatus,
    ReportPeriodType,
    SecurityType,
)
from app.services.dividend_cninfo_parse import retention_cutoff_year
from tests.helpers import auth, env, register_login

_BASE = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _uid() -> str:
    return str(uuid.uuid4())


async def _master(session, code="600519", name="贵州茅台") -> str:
    m = Security(
        id=_uid(), code=code, name=name, exchange="SH", asset_class=SecurityType.STOCK
    )
    session.add(m)
    await session.flush()
    return m.id


def _pending(
    mid: str,
    *,
    label=None,
    cash="10.0",
    fp=None,
    created_at=None,
    ex=None,
    pid=None,
    bonus=None,
    convert=None,
    record=None,
    ann=None,
) -> SecurityDividendPending:
    ts = created_at or datetime.now(timezone.utc)
    return SecurityDividendPending(
        id=pid or _uid(),
        master_id=mid,
        row_fingerprint=fp or uuid.uuid4().hex,
        dividend_label=label,
        cash_per_share=Decimal(cash),
        status=DividendPendingStatus.PENDING,
        ex_dividend_date=ex,
        bonus_share_ratio=None if bonus is None else Decimal(bonus),
        convert_ratio=None if convert is None else Decimal(convert),
        record_date=record,
        announcement_date=ann,
        report_period_raw="未知报告期",
        created_at=ts,
        updated_at=ts,
    )


async def _make_role(session, client, email: str, role: str) -> dict:
    """注册用户并按 DB 实时 role 提升（require_any_role 以库内 role 为准）。"""
    info = await register_login(client, email=email)
    await session.execute(update(User).where(User.email == email).values(role=role))
    await session.commit()
    return info


# ───────────────────────── 鉴权矩阵 ─────────────────────────
@pytest.mark.asyncio
async def test_pending_auth_matrix(session, client):
    """admin 全通；auditor 只读可读、写 403；普通 user 读 403；未登录 401。"""
    admin = await _make_role(session, client, "adm@example.com", "admin")
    auditor = await _make_role(session, client, "aud@example.com", "auditor")
    plain = await register_login(client, email="u@example.com")
    await _master(session)
    await session.commit()

    list_url = "/api/dividend-yield/pending-dividends"
    summary_url = "/api/dividend-yield/pending-dividends/summary"

    # 未登录 → 401
    assert (await client.get(list_url)).status_code == 401
    assert (await client.get(summary_url)).status_code == 401

    # 普通 user 读 → 403
    assert (await client.get(list_url, headers=auth(plain["token"]))).status_code == 403

    # admin / auditor 读 → 200
    for who in (admin, auditor):
        assert (await client.get(list_url, headers=auth(who["token"]))).status_code == 200
        assert (
            await client.get(summary_url, headers=auth(who["token"]))
        ).status_code == 200

    # 写端点：未登录 401 / auditor 403 / admin 200（id 不存在 → failed[].NOT_FOUND）
    ignore_url = "/api/dividend-yield/pending-dividends/batch-ignore"
    assert (await client.post(ignore_url, json={"ids": ["x"]})).status_code == 401
    assert (
        await client.post(
            ignore_url, json={"ids": ["x"]}, headers=auth(auditor["token"])
        )
    ).status_code == 403
    st, code, data, _ = env(
        await client.post(ignore_url, json={"ids": ["none"]}, headers=auth(admin["token"]))
    )
    assert st == 200 and code == 0
    assert data["succeeded"] == 0
    assert data["failed"][0]["code"] == "NOT_FOUND"


# ───────────────────────── 列表：筛选 + 固定排序 + 分页 ─────────────────────────
@pytest.mark.asyncio
async def test_pending_list_filters_and_fixed_order(session, client):
    """固定排序 ``created_at DESC, id DESC``；label 精确筛选；q 代码/名称模糊；分页。"""
    admin = await _make_role(session, client, "adm-list@example.com", "admin")
    h = auth(admin["token"])
    mid = await _master(session, code="600519", name="贵州茅台")

    r1 = _pending(mid, label="股改分红", created_at=_BASE + timedelta(seconds=2),
                  pid="00000000-0000-0000-0000-0000000000aa")
    r2 = _pending(mid, label=None, created_at=_BASE + timedelta(seconds=1),
                  pid="00000000-0000-0000-0000-0000000000bb")
    # r3 与 r1 同 created_at，靠 id DESC 应排在 r1 之前
    r3 = _pending(mid, label="中期分红", created_at=_BASE + timedelta(seconds=2),
                  pid="ffffffff-0000-0000-0000-0000000000cc")
    session.add_all([r1, r2, r3])
    await session.commit()
    ids = [r3.id, r1.id, r2.id]  # created_at DESC, id DESC

    st, _, data, _ = env(
        await client.get(
            "/api/dividend-yield/pending-dividends", headers=h
        )
    )
    assert st == 200
    assert data["total"] == 3
    assert [i["id"] for i in data["items"]] == ids

    # label 精确筛选
    st, _, data, _ = env(
        await client.get(
            "/api/dividend-yield/pending-dividends", params={"label": "股改分红"}, headers=h
        )
    )
    assert [i["id"] for i in data["items"]] == [r1.id]

    # q = 名称模糊
    st, _, data, _ = env(
        await client.get(
            "/api/dividend-yield/pending-dividends", params={"q": "茅台"}, headers=h
        )
    )
    assert data["total"] == 3

    # q = 不存在的代码 → 空
    st, _, data, _ = env(
        await client.get(
            "/api/dividend-yield/pending-dividends", params={"q": "000001"}, headers=h
        )
    )
    assert data["total"] == 0

    # 分页：pageSize=2 → 2 条，total 仍 3
    st, _, data, _ = env(
        await client.get(
            "/api/dividend-yield/pending-dividends",
            params={"page": 1, "pageSize": 2},
            headers=h,
        )
    )
    assert len(data["items"]) == 2
    assert data["total"] == 3

    # status 非法 → 400
    assert (
        await client.get(
            "/api/dividend-yield/pending-dividends", params={"status": "BAD"}, headers=h
        )
    ).status_code == 400


@pytest.mark.asyncio
async def test_pending_summary_counts_and_labels(session, client):
    """summary：各状态计数 + ``labels[]`` 含 KNOWN_LABELS ∪ 表内标签。"""
    admin = await _make_role(session, client, "adm-sum@example.com", "admin")
    h = auth(admin["token"])
    mid = await _master(session)
    a = _pending(mid, label="股改分红")
    b = _pending(mid, label="重整转增")
    c = _pending(mid, label=None)
    session.add_all([a, b, c])
    await session.commit()
    c.status = DividendPendingStatus.IGNORED
    await session.commit()

    st, _, data, _ = env(
        await client.get("/api/dividend-yield/pending-dividends/summary", headers=h)
    )
    assert st == 200
    assert data["pending"] == 2
    assert data["ignored"] == 1
    assert data["assigned"] == 0
    assert data["total"] == 3
    # KNOWN_LABELS（年度/中期/季度/特别/股改分红）∪ 表内（重整转增）
    assert "年度分红" in data["labels"]
    assert "股改分红" in data["labels"]
    assert "重整转增" in data["labels"]
    assert data["labels"] == sorted(data["labels"])


# ───────────────────────── assign：冲突保留旧值 ─────────────────────────
@pytest.mark.asyncio
async def test_assign_conflict_keeps_existing(session, client):
    """主表同格已存在 → ``conflict=True``、warning 提示未覆盖、**主表旧值逐字段保持不变**。

    ``_insert_main`` 写入的主表字段共 12 个（含 source / 送转 / 三个日期 / status / 键列）；
    仅断言其中 2 个（cash/label）会漏掉「部分字段被覆盖」的回归，故逐字段钉死。主表现有行
    与待划分行各字段取值**均不同**——一旦实现误用 ``DO UPDATE`` 覆盖，任一项都会被抓到。
    """
    admin = await _make_role(session, client, "adm-cf@example.com", "admin")
    h = auth(admin["token"])
    mid = await _master(session)
    session.add(
        SecurityDividend(
            master_id=mid, report_year=2024, report_quarter=4,
            period_type=ReportPeriodType.ANNUAL, cash_per_share=Decimal("5.0"),
            status=DividendStatus.PAID, dividend_label="旧标签",
            source="旧源", ex_dividend_date=date(2024, 6, 10),
            announcement_date=date(2024, 5, 20), record_date=date(2024, 6, 9),
            bonus_share_ratio=Decimal("0.3"), convert_ratio=Decimal("0.4"),
        )
    )
    p = _pending(
        mid, label="本次标签", cash="12.5", ex=date(2024, 7, 1),
        bonus="0.9", convert="0.8", record=date(2024, 6, 30), ann=date(2024, 6, 20),
    )
    session.add(p)
    await session.commit()
    pid = p.id

    st, code, data, _ = env(
        await client.post(
            f"/api/dividend-yield/pending-dividends/{pid}/assign",
            json={"reportYear": 2024, "reportQuarter": 4, "periodType": "ANNUAL"},
            headers=h,
        )
    )
    assert st == 200 and code == 0
    assert data["conflict"] is True
    assert data["status"] == "ASSIGNED"
    assert "未覆盖" in data["warning"]

    session.expire_all()
    row = (
        await session.execute(
            select(SecurityDividend).where(SecurityDividend.master_id == mid)
        )
    ).scalar_one()
    # 12 字段逐项不被覆盖（主表原值保持）
    assert row.cash_per_share == Decimal("5.0")
    assert row.dividend_label == "旧标签"
    assert row.source == "旧源"
    assert row.bonus_share_ratio == Decimal("0.3")
    assert row.convert_ratio == Decimal("0.4")
    assert row.record_date == date(2024, 6, 9)
    assert row.ex_dividend_date == date(2024, 6, 10)
    assert row.announcement_date == date(2024, 5, 20)
    assert row.status is DividendStatus.PAID
    assert row.report_year == 2024
    assert row.report_quarter == 4
    assert row.period_type is ReportPeriodType.ANNUAL

    p2 = await session.get(SecurityDividendPending, pid)
    await session.refresh(p2)
    assert p2.status.value == "ASSIGNED"
    assert p2.resolved_period_type == "ANNUAL"  # 存字符串，非枚举
    assert p2.resolved_report_year == 2024
    assert p2.resolved_report_quarter == 4
    assert p2.resolved_by == admin["user_id"]


@pytest.mark.asyncio
async def test_assign_inserts_main_row(session, client):
    """未命中 → 写回主表（source=人工划分、除权日非空 → PAID）。"""
    admin = await _make_role(session, client, "adm-ins@example.com", "admin")
    h = auth(admin["token"])
    mid = await _master(session)
    p = _pending(mid, cash="12.5", label="中期分红", ex=date(2024, 9, 1))
    session.add(p)
    await session.commit()
    pid = p.id

    st, _, data, _ = env(
        await client.post(
            f"/api/dividend-yield/pending-dividends/{pid}/assign",
            json={"reportYear": 2024, "reportQuarter": 2, "periodType": "INTERIM"},
            headers=h,
        )
    )
    assert st == 200
    assert data["conflict"] is False
    assert data["warning"] is None
    assert data["periodType"] == "INTERIM"

    session.expire_all()
    row = (
        await session.execute(
            select(SecurityDividend).where(SecurityDividend.master_id == mid)
        )
    ).scalar_one()
    assert row.cash_per_share == Decimal("12.5")
    assert row.status is DividendStatus.PAID
    assert row.source == "人工划分"
    assert row.dividend_label == "中期分红"


@pytest.mark.asyncio
async def test_assign_non_pending_is_not_found(session, client):
    """非 PENDING（已 IGNORED）→ 404（§4.1 表：assign 只列 404）。"""
    admin = await _make_role(session, client, "adm-st@example.com", "admin")
    h = auth(admin["token"])
    mid = await _master(session)
    p = _pending(mid)
    session.add(p)
    await session.commit()
    p.status = DividendPendingStatus.IGNORED
    await session.commit()
    pid = p.id

    r = await client.post(
        f"/api/dividend-yield/pending-dividends/{pid}/assign",
        json={"reportYear": 2024, "reportQuarter": 4, "periodType": "ANNUAL"},
        headers=h,
    )
    assert r.status_code == 404


# ───────────────────────── 批量：部分失败 ─────────────────────────
@pytest.mark.asyncio
async def test_batch_assign_partial_failure(session, client):
    """批量划分：成功 1、失败含 NOT_FOUND / INVALID_STATE / VALIDATION_FAILED。"""
    admin = await _make_role(session, client, "adm-ba@example.com", "admin")
    h = auth(admin["token"])
    mid = await _master(session)
    ok = _pending(mid, cash="9.0")
    ignored = _pending(mid, cash="9.0")
    bad_quarter = _pending(mid, cash="9.0")
    session.add_all([ok, ignored, bad_quarter])
    await session.commit()
    ignored.status = DividendPendingStatus.IGNORED
    await session.commit()
    ok_id, ignored_id, bad_id = ok.id, ignored.id, bad_quarter.id

    st, code, data, _ = env(
        await client.post(
            "/api/dividend-yield/pending-dividends/batch-assign",
            json={
                "items": [
                    {"id": ok_id, "reportYear": 2024, "reportQuarter": 4, "periodType": "ANNUAL"},
                    {"id": ignored_id, "reportYear": 2024, "reportQuarter": 4, "periodType": "ANNUAL"},
                    {"id": "00000000-0000-0000-0000-000000000000", "reportYear": 2024, "reportQuarter": 4, "periodType": "ANNUAL"},
                    {"id": bad_id, "reportYear": 2024, "reportQuarter": 9, "periodType": "ANNUAL"},
                ]
            },
            headers=h,
        )
    )
    assert st == 200 and code == 0
    assert data["succeeded"] == 1
    codes = {f["code"] for f in data["failed"]}
    assert codes == {"INVALID_STATE", "NOT_FOUND", "VALIDATION_FAILED"}
    assert len(data["failed"]) == 3

    session.expire_all()
    assert (
        await session.execute(
            select(SecurityDividend).where(SecurityDividend.master_id == mid)
        )
    ).scalar_one() is not None


# ───────────────────────── 批量：单项入库异常隔离（DB_ERROR） ─────────────────────────
@pytest.mark.asyncio
async def test_batch_assign_db_error_isolated(session, client, monkeypatch):
    """单项入库异常 → 该 item 落 ``failed[]`` 且 ``code == "DB_ERROR"``；**同批其他项照常成功**。

    QA 建议：``batch_assign`` 的 ``except Exception``（DB_ERROR）分支此前无覆盖。批处理
    不应被单项异常整体带挂——注入中间项抛错，断言其余两项正常写回主表、整批不中断。
    """
    from app.services.dividend_pending import PendingDividendService

    admin = await _make_role(session, client, "adm-dberr@example.com", "admin")
    h = auth(admin["token"])
    mid = await _master(session)
    good1 = _pending(mid, cash="9.0")
    boom = _pending(mid, cash="9.0")
    good2 = _pending(mid, cash="9.0")
    session.add_all([good1, boom, good2])
    await session.commit()
    good1_id, boom_id, good2_id = good1.id, boom.id, good2.id

    original = PendingDividendService._assign_one

    async def _flaky(self, pending_id, **kwargs):
        if pending_id == boom_id:
            raise RuntimeError("模拟单项入库失败")
        return await original(self, pending_id, **kwargs)

    monkeypatch.setattr(PendingDividendService, "_assign_one", _flaky)

    st, code, data, _ = env(
        await client.post(
            "/api/dividend-yield/pending-dividends/batch-assign",
            json={
                "items": [
                    {"id": good1_id, "reportYear": 2024, "reportQuarter": 4, "periodType": "ANNUAL"},
                    {"id": boom_id, "reportYear": 2024, "reportQuarter": 4, "periodType": "ANNUAL"},
                    {"id": good2_id, "reportYear": 2023, "reportQuarter": 4, "periodType": "ANNUAL"},
                ]
            },
            headers=h,
        )
    )
    assert st == 200 and code == 0
    assert data["succeeded"] == 2, "单项 DB 异常不得带挂整批"
    assert len(data["failed"]) == 1
    assert data["failed"][0]["id"] == boom_id
    assert data["failed"][0]["code"] == "DB_ERROR"

    # 其余两项已独立提交写回主表（2024Q4 + 2023Q4 各一行），失败项未写主表
    session.expire_all()
    rows = (
        await session.execute(
            select(SecurityDividend).where(SecurityDividend.master_id == mid)
        )
    ).scalars().all()
    assert len(rows) == 2
    boom_p = await session.get(SecurityDividendPending, boom_id)
    await session.refresh(boom_p)
    assert boom_p.status.value == "PENDING"  # 失败项未被置 ASSIGNED


@pytest.mark.asyncio
async def test_batch_ignore_db_error_isolated(session, client, monkeypatch):
    """``batch_ignore`` 的 DB_ERROR 分支：单项异常被隔离，其余项照常置 IGNORED。"""
    from app.services.dividend_pending import PendingDividendService

    admin = await _make_role(session, client, "adm-iger@example.com", "admin")
    h = auth(admin["token"])
    mid = await _master(session)
    a = _pending(mid)
    b = _pending(mid)
    c = _pending(mid)
    session.add_all([a, b, c])
    await session.commit()
    a_id, b_id, c_id = a.id, b.id, c.id

    original = PendingDividendService._ignore_one

    async def _flaky(self, pending_id):
        if pending_id == b_id:
            raise RuntimeError("模拟单项入库失败")
        return await original(self, pending_id)

    monkeypatch.setattr(PendingDividendService, "_ignore_one", _flaky)

    st, code, data, _ = env(
        await client.post(
            "/api/dividend-yield/pending-dividends/batch-ignore",
            json={"ids": [a_id, b_id, c_id]},
            headers=h,
        )
    )
    assert st == 200 and code == 0
    assert data["succeeded"] == 2
    assert len(data["failed"]) == 1
    assert data["failed"][0]["id"] == b_id
    assert data["failed"][0]["code"] == "DB_ERROR"

    session.expire_all()
    b_p = await session.get(SecurityDividendPending, b_id)
    await session.refresh(b_p)
    assert b_p.status.value == "PENDING"  # 失败项未被置 IGNORED


# ───────────────────────── reopen：回滚 ─────────────────────────
@pytest.mark.asyncio
async def test_reopen_deletes_main_row_and_resets(session, client):
    """assign 后 reopen：主表同键行被删、``rolledBack=True``、pending 回 PENDING 并清 resolved_*。"""
    admin = await _make_role(session, client, "adm-ro@example.com", "admin")
    h = auth(admin["token"])
    mid = await _master(session)
    p = _pending(mid, cash="8.0", label="股改分红")
    session.add(p)
    await session.commit()
    pid = p.id

    # 先 assign 写回主表
    st, _, _, _ = env(
        await client.post(
            f"/api/dividend-yield/pending-dividends/{pid}/assign",
            json={"reportYear": 2023, "reportQuarter": 4, "periodType": "OTHER"},
            headers=h,
        )
    )
    assert st == 200
    session.expire_all()
    assert (
        await session.execute(
            select(SecurityDividend).where(SecurityDividend.master_id == mid)
        )
    ).scalar_one() is not None

    # reopen
    st, code, data, _ = env(
        await client.post(
            f"/api/dividend-yield/pending-dividends/{pid}/reopen", headers=h
        )
    )
    assert st == 200 and code == 0
    assert data["status"] == "PENDING"
    assert data["rolledBack"] is True

    session.expire_all()
    assert (
        await session.execute(
            select(SecurityDividend).where(SecurityDividend.master_id == mid)
        )
    ).scalars().all() == []
    p2 = await session.get(SecurityDividendPending, pid)
    await session.refresh(p2)
    assert p2.status.value == "PENDING"
    assert p2.resolved_period_type is None
    assert p2.resolved_at is None
    assert p2.resolved_by is None


@pytest.mark.asyncio
async def test_reopen_requires_assigned(session, client):
    """非 ASSIGNED → 409（§4.6 仅 ASSIGNED 可撤销）。"""
    admin = await _make_role(session, client, "adm-ro2@example.com", "admin")
    h = auth(admin["token"])
    mid = await _master(session)
    p = _pending(mid)
    session.add(p)
    await session.commit()
    pid = p.id

    r = await client.post(
        f"/api/dividend-yield/pending-dividends/{pid}/reopen", headers=h
    )
    assert r.status_code == 409


# ───────────── assign：留存窗硬拒（A3=①） ─────────────
@pytest.mark.asyncio
async def test_assign_rejects_year_outside_retention_window(session, client):
    """留存窗外年份**硬拒**（400）且不写主表。

    窗外年份会被留存清理（``dividend_sync.retention_cleanup``）删除，划分等于「成功但过一阵
    静默消失」；而待划分队列主力恰是股改类窗外年份。把关必须在后端——前端
    （``suggest-report-period``）只给提示，直连 API 可绕过。
    """
    admin = await _make_role(session, client, "adm-win@example.com", "admin")
    h = auth(admin["token"])
    mid = await _master(session)
    p = _pending(mid, cash="8.0", label="股改分红")
    session.add(p)
    await session.commit()
    pid = p.id

    # 早于留存窗下界一年（窗内按同一函数取，故不依赖测试库里留存年数配置的具体值）
    outside = retention_cutoff_year(today_app_tz(), DEFAULT_DIVIDEND_RETENTION_YEARS) - 1
    r = await client.post(
        f"/api/dividend-yield/pending-dividends/{pid}/assign",
        json={"reportYear": outside, "reportQuarter": 4, "periodType": "ANNUAL"},
        headers=h,
    )
    assert r.status_code == 400, "留存窗外年份须 400（而非静默写入后被清理）"

    session.expire_all()
    assert (
        await session.execute(
            select(SecurityDividend).where(SecurityDividend.master_id == mid)
        )
    ).scalars().all() == [], "被拒的划分不得写入主表"
    p2 = await session.get(SecurityDividendPending, pid)
    await session.refresh(p2)
    assert p2.status.value == "PENDING", "被拒后须仍为待划分态"


# ───────────── reopen：来源守卫（A4=②） ─────────────
@pytest.mark.asyncio
async def test_reopen_keeps_non_assign_row(session, client):
    """assign 命中「主表同格已存在」（本次未写入任何行）→ reopen 不得删采集侧那行。

    原实现只按 ``resolved_*`` 四元组键删，会把采集侧写入的合法行一并删掉却报
    ``rolledBack=true``；加 ``source = 人工划分`` 守卫后，该情形退化为「不删」（安全侧）。
    """
    admin = await _make_role(session, client, "adm-rbg@example.com", "admin")
    h = auth(admin["token"])
    mid = await _master(session)
    inside = retention_cutoff_year(today_app_tz(), DEFAULT_DIVIDEND_RETENTION_YEARS)
    session.add(
        SecurityDividend(
            master_id=mid,
            report_year=inside,
            report_quarter=4,
            period_type=ReportPeriodType.OTHER,
            cash_per_share=Decimal("9.9"),
            status=DividendStatus.PAID,
            dividend_label="采集侧标签",
            source="巨潮",
        )
    )
    p = _pending(mid, cash="8.0", label="股改分红")
    session.add(p)
    await session.commit()
    pid = p.id

    st, _, data, _ = env(
        await client.post(
            f"/api/dividend-yield/pending-dividends/{pid}/assign",
            json={
                "reportYear": inside,
                "reportQuarter": 4,
                "periodType": "OTHER",
            },
            headers=h,
        )
    )
    assert st == 200
    assert data["conflict"] is True, "同格已存在 → conflict=True（本次未写入任何行）"

    st2, _, data2, _ = env(
        await client.post(
            f"/api/dividend-yield/pending-dividends/{pid}/reopen", headers=h
        )
    )
    assert st2 == 200
    assert data2["rolledBack"] is False, "未写入任何行 → 无行可撤（守卫失效方向须为「不删」）"

    session.expire_all()
    rows = (
        await session.execute(
            select(SecurityDividend).where(SecurityDividend.master_id == mid)
        )
    ).scalars().all()
    assert len(rows) == 1 and rows[0].source == "巨潮", "采集侧写入的行须被保留"


# ───────────────────────── ignore ─────────────────────────
@pytest.mark.asyncio
async def test_ignore_pending(session, client):
    """ignore：PENDING → IGNORED；不写回主表。"""
    admin = await _make_role(session, client, "adm-ig@example.com", "admin")
    h = auth(admin["token"])
    mid = await _master(session)
    p = _pending(mid)
    session.add(p)
    await session.commit()
    pid = p.id

    st, _, data, _ = env(
        await client.post(
            f"/api/dividend-yield/pending-dividends/{pid}/ignore", headers=h
        )
    )
    assert st == 200
    assert data["status"] == "IGNORED"

    session.expire_all()
    p2 = await session.get(SecurityDividendPending, pid)
    await session.refresh(p2)
    assert p2.status.value == "IGNORED"
    assert (
        await session.execute(
            select(SecurityDividend).where(SecurityDividend.master_id == mid)
        )
    ).scalars().all() == []
