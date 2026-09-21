"""待人工划分分红端点集成测试（批次 C，§4）。

覆盖：
- 鉴权矩阵：admin 全通 / auditor 只读可读、写 403 / 普通 user 读 403 / 未登录 401；
- 列表分页、筛选（status/label/q）、**固定排序** ``created_at DESC, id DESC``；
- assign 冲突路径（``conflict=True`` 且主表旧值**未被覆盖**）；
- assign 非冲突路径（写回主表，source=人工划分、status 按除权日推导）；
- 批量部分失败（``{succeeded, failed[]}`` 含 NOT_FOUND / INVALID_STATE / VALIDATION_FAILED）；
- reopen 回滚（主表行被删 + ``rolledBack=True`` + pending 回 PENDING 且清 ``resolved_*``）；
- ignore（PENDING → IGNORED）与非 PENDING 状态保护。
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy import select, update

from app.models import Security, SecurityDividend, SecurityDividendPending, User
from app.models.enums import (
    DividendPendingStatus,
    DividendStatus,
    ReportPeriodType,
    SecurityType,
)
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
    """主表同格已存在 → ``conflict=True``、warning 提示未覆盖、旧值保持不变。"""
    admin = await _make_role(session, client, "adm-cf@example.com", "admin")
    h = auth(admin["token"])
    mid = await _master(session)
    session.add(
        SecurityDividend(
            master_id=mid, report_year=2024, report_quarter=4,
            period_type=ReportPeriodType.ANNUAL, cash_per_share=Decimal("5.0"),
            status=DividendStatus.PAID, dividend_label="旧标签",
        )
    )
    p = _pending(mid, label="本次标签", cash="12.5")
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
    assert row.cash_per_share == Decimal("5.0")  # 旧值未被覆盖
    assert row.dividend_label == "旧标签"

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
