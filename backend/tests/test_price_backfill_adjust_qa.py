"""QA 独立验证（迁移 0022）：``price_backfill_adjust`` 真正驱动历史回补抓取。

本文件由独立 QA 编写，**不采信工程师自述**，通过 monkeypatch
``MarketDataSyncService._fetch_sdk_raw`` 捕获真实入参，覆盖「两面」：
  1) hfq / qfq 生效 → akshare ``adjust`` 入参被改写；
  2) 默认 ``''``（不复权，含「未提供该字段」的存量路径）→ 入参仍为 ``''``（零行为变更）。

另含边界：非法值 400 且不落库、GET 回显含 ``price_backfill_adjust``（默认行返回 ``''``）。
"""
from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select, update

from app.models import (
    DividendYieldSettings,
    InterfaceCategory,
    QuoteInterface,
    SecuritiesDataProvider,
    Security,
    SecurityDividend,
    User,
)
from app.models.enums import (
    DividendStatus,
    QuoteProviderAccessMethod,
    ReportPeriodType,
    SecurityType,
)
from app.services.market_data_sync import QUOTE_CAT_ID
from tests.helpers import auth, env, register_login


def _uid() -> str:
    return str(uuid.uuid4())


async def _make_admin(session, client) -> dict:
    """注册用户并提升为 admin（require_admin 以 DB 实时 role 为准）。"""
    info = await register_login(client, email="qa-boss@example.com")
    await session.execute(
        update(User).where(User.email == "qa-boss@example.com").values(role="admin")
    )
    await session.commit()
    return info


async def _seed_category2_interface(session, *, access_method: str) -> QuoteInterface:
    """分类 2「证券行情」+ sdk 提供方 + stock_zh_a_hist 接口，供回补源校验通过。"""
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    provider = SecuritiesDataProvider(
        id=_uid(),
        name="akshare",
        access_method=access_method,
        config={},
        enabled=True,
    )
    session.add(provider)
    await session.flush()
    itf = QuoteInterface(
        id=_uid(),
        provider_id=provider.id,
        category_id=QUOTE_CAT_ID,
        name="东财-历史行情",
        endpoint="stock_zh_a_hist",
        enabled=True,
        params={"date": "20231231"},
    )
    session.add(itf)
    await session.commit()
    return itf


async def _seed_pending_master(session) -> Security:
    """造一只会被 ``run_pending_price_backfill`` 选中的待回补证券。"""
    m = Security(
        id=_uid(),
        code="sh600888",
        name="证券sh600888",
        asset_class=SecurityType.STOCK,
        exchange="SH",
    )
    session.add(m)
    session.add(
        SecurityDividend(
            master_id=m.id,
            report_year=date.today().year,
            report_quarter=4,
            period_type=ReportPeriodType.ANNUAL,
            cash_per_share=Decimal("1.0"),
            status=DividendStatus.PAID,
        )
    )
    await session.commit()
    return m


_OMIT = object()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("send_adjust", "expected_param", "label"),
    [
        ("hfq", "hfq", "hfq-生效"),
        ("qfq", "qfq", "qfq-生效"),
        ("", "", "空串-不复权"),
        (_OMIT, "", "未提供字段-存量默认零变更"),
    ],
)
async def test_price_backfill_adjust_drives_fetch_params(
    session, client, monkeypatch, send_adjust, expected_param, label
):
    """核心实证：回补链路把配置值透传到 akshare ``adjust`` 入参。"""
    import app.services.market_price_backfill_engine as mds
    from app.services.market_daily_price_sync import run_pending_price_backfill

    captured: list[dict] = []

    async def _fake_sdk(self, itf_obj, params, codes):
        captured.append(dict(params))
        return [{"日期": "2024-01-02", "收盘": "10.50"}]

    monkeypatch.setattr(mds.MarketDataSyncService, "_fetch_sdk_raw", _fake_sdk)
    monkeypatch.setattr(mds, "_BACKFILL_BACKOFFS", (0,))
    monkeypatch.setattr(mds, "_BACKFILL_COOLDOWN_MIN", 0)
    monkeypatch.setattr(mds, "_BACKFILL_COOLDOWN_MAX", 0)

    admin = await _make_admin(session, client)
    h = auth(admin["token"])
    itf = await _seed_category2_interface(
        session, access_method=QuoteProviderAccessMethod.SDK
    )

    body: dict = {
        "price_backfill_source_interface_id": itf.id,
    }
    if send_adjust is not _OMIT:
        body["price_backfill_adjust"] = send_adjust
    r = await client.put("/api/dividend-yield/settings", json=body, headers=h)
    assert r.status_code == 200, f"[{label}] PUT 失败：{r.text}"

    await _seed_pending_master(session)
    settings = (
        await session.execute(select(DividendYieldSettings).limit(1))
    ).scalar_one()
    # 先证「存」：DB 中确实落成期望值（'' 亦为默认）
    assert settings.price_backfill_adjust == expected_param, (
        f"[{label}] 落库值错误：{settings.price_backfill_adjust!r}"
    )
    # 再置在途任务，使 run_pending_price_backfill 真正取批并抓取
    settings.price_backfill_start_date = date(2024, 1, 1)
    await session.commit()

    await run_pending_price_backfill(session)

    assert captured, f"[{label}] 应发生历史回补抓取请求"
    assert captured[0]["adjust"] == expected_param, (
        f"[{label}] 传给 akshare 的 adjust 错误："
        f"{captured[0].get('adjust')!r}（期望 {expected_param!r}）"
    )


@pytest.mark.asyncio
async def test_invalid_adjust_400_and_not_persisted(session, client):
    """非法 adjust → PUT 400，且**不落库**（GET 仍是上一个合法值）。"""
    admin = await _make_admin(session, client)
    h = auth(admin["token"])
    itf = await _seed_category2_interface(
        session, access_method=QuoteProviderAccessMethod.SDK
    )

    # 先落一个合法值 qfq
    ok = await client.put(
        "/api/dividend-yield/settings",
        json={
            "price_backfill_source_interface_id": itf.id,
            "price_backfill_adjust": "qfq",
        },
        headers=h,
    )
    assert ok.status_code == 200, ok.text

    # 非法值应被拒
    bad = await client.put(
        "/api/dividend-yield/settings",
        json={
            "price_backfill_adjust": "xxx",
        },
        headers=h,
    )
    status, _, _, message = env(bad)
    assert status == 400, f"非法 adjust 应 400（实际 {status}）"
    assert "price_backfill_adjust" in message

    # 不落库：GET 仍是 qfq
    get = await client.get("/api/dividend-yield/settings", headers=h)
    get_status, _, data, _ = env(get)
    assert get_status == 200
    assert data["price_backfill_adjust"] == "qfq", (
        f"非法 PUT 不应改动旧值，实际 {data['price_backfill_adjust']!r}"
    )


@pytest.mark.asyncio
async def test_get_settings_echoes_adjust_default_empty(session, client):
    """GET /settings 回显含 price_backfill_adjust；无持久化行时默认返回 ''。"""
    info = await register_login(client, email="qa-user@example.com")
    h = auth(info["token"])
    r = await client.get("/api/dividend-yield/settings", headers=h)
    status, _, data, _ = env(r)
    assert status == 200
    assert "price_backfill_adjust" in data
    assert data["price_backfill_adjust"] == ""
