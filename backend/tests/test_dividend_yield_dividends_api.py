"""GET /api/dividend-yield/{master_id}/dividends 端到端用例（分红明细 · 按报告期）。

守护契约：
- 只返回**有分红**的期次（cash_per_share > 0），无分红的报告期不出现；
- 按报告期倒序（年降 → 季降 → period_type 升）；
- periodLabel / planLabel 由后端生成（2025年报 / 2025三季报 / 2023特别分配 + 10派3元）；
- 登录可用（与 rankings 同口径 get_current_user），未登录 401。
"""
from __future__ import annotations

from decimal import Decimal

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Security, SecurityDividend
from app.models.enums import DividendStatus, ReportPeriodType, SecurityType
from tests.helpers import auth, env, register_login


async def _new_master(session: AsyncSession, code: str) -> str:
    sec = Security(
        code=code, name=f"证券{code}", exchange="SH", asset_class=SecurityType.STOCK
    )
    session.add(sec)
    await session.commit()
    await session.refresh(sec, ["id"])
    return sec.id


def _div(
    master_id: str,
    year: int,
    quarter: int,
    period_type: ReportPeriodType,
    cash: str,
    status: DividendStatus = DividendStatus.PAID,
    ex_date: object = None,
) -> SecurityDividend:
    return SecurityDividend(
        master_id=master_id,
        report_year=year,
        report_quarter=quarter,
        period_type=period_type,
        cash_per_share=Decimal(cash),
        status=status,
        ex_dividend_date=ex_date,
    )


@pytest.mark.asyncio
async def test_dividends_filters_zero_and_orders_by_period(session, client):
    info = await register_login(client)
    h = auth(info["token"])
    mid = await _new_master(session, "600001")

    session.add_all(
        [
            # 有分红：2025 年报 / 2025 三季报 / 2023 特别分配
            _div(mid, 2025, 4, ReportPeriodType.ANNUAL, "0.3"),
            _div(mid, 2025, 3, ReportPeriodType.QUARTERLY, "0.15"),
            _div(mid, 2023, 4, ReportPeriodType.SPECIAL, "0.8"),
            # 无分红（cash_per_share = 0）：2025 半年报 → 不应出现
            _div(mid, 2025, 2, ReportPeriodType.INTERIM, "0"),
        ]
    )
    await session.commit()

    st, code, data, msg = env(
        await client.get(f"/api/dividend-yield/{mid}/dividends", headers=h)
    )
    assert st == 200 and code == 0, (st, code, msg)
    assert data["masterId"] == mid

    items = data["items"]
    # 零分红期次被剔除
    assert len(items) == 3
    # 报告期倒序 + 文案由后端生成
    assert [i["periodLabel"] for i in items] == [
        "2025年报",
        "2025三季报",
        "2023特别分配",
    ]
    assert [i["planLabel"] for i in items] == ["10派3元", "10派1.5元", "10派8元"]
    # 每股金额与状态原样回传（字符串防前端类型漂移）
    assert items[0]["cashPerShare"].startswith("0.3")
    assert items[0]["status"] == "PAID"
    assert items[0]["periodType"] == "ANNUAL"
    assert items[2]["periodType"] == "SPECIAL"


@pytest.mark.asyncio
async def test_dividends_empty_when_no_positive_period(session, client):
    """只有零分红行（或完全无行）→ 空 items，不报错。"""
    info = await register_login(client)
    h = auth(info["token"])
    mid = await _new_master(session, "600002")

    session.add(_div(mid, 2025, 4, ReportPeriodType.ANNUAL, "0"))
    await session.commit()

    st, code, data, msg = env(
        await client.get(f"/api/dividend-yield/{mid}/dividends", headers=h)
    )
    assert st == 200 and code == 0, (st, code, msg)
    assert data["items"] == []

    # 完全无分红行的证券
    other = await _new_master(session, "600003")
    st, code, data, _ = env(
        await client.get(f"/api/dividend-yield/{other}/dividends", headers=h)
    )
    assert st == 200 and code == 0
    assert data["items"] == []


@pytest.mark.asyncio
async def test_dividends_requires_login(session, client):
    mid = await _new_master(session, "600004")
    r = await client.get(f"/api/dividend-yield/{mid}/dividends")
    assert r.status_code == 401
