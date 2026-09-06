"""股息率排名 API 路由层测试（守护方案 §8/§9/§12）。

覆盖审查报告 P0-2/P0-3/P0-4 与 §12「API/配置」项：
排序白名单 400、NULL 股息率不进榜、近两年无分红默认剔除（§8.2/§8.3）、
``include_proposed=false`` 过滤态股息率现算（§8.1）、min_consecutive / exchange 过滤、
/top20 双榜契约（suspicious + 僵尸剔除、consecutive >= 2、A13）、
settings 阈值校验与接口四重校验 400（§5.4）、非 admin 403。
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone as tz
from decimal import Decimal

import pytest
from sqlalchemy import update

from app.models import (
    InterfaceCategory,
    MarketSecurityDailyPrice,
    QuoteInterface,
    SecuritiesDataProvider,
    Security,
    SecurityDividend,
    SecurityDividendYield,
    User,
)
from app.models.enums import (
    DividendStatus,
    DividendYieldMode,
    QuoteProviderAccessMethod,
    ReportPeriodType,
    SecurityType,
)
from app.services.market_data_sync import DIVIDEND_LIST_CAT_ID
from tests.helpers import auth, env, register_login

_DIVIDEND_CAT_ID = DIVIDEND_LIST_CAT_ID


def _uid() -> str:
    return str(uuid.uuid4())


async def _seed_snapshot(
    session,
    code: str,
    *,
    dividend_yield: str | None = "0.08",
    mode: DividendYieldMode = DividendYieldMode.TTM,
    consecutive: int = 3,
    last_year: int | None = None,
    suspicious: bool = False,
    exchange: str | None = "SH",
    numerator: str = "1.0",
    price: str = "12.5",
):
    """造一条目录主数据 + 对应派生快照，返回 (master, snapshot)。"""
    cur = date.today().year
    m = Security(
        id=_uid(), code=code, name=f"证券{code}",
        asset_class=SecurityType.STOCK, exchange=exchange,
    )
    session.add(m)
    await session.flush()
    snap = SecurityDividendYield(
        master_id=m.id,
        mode=mode,
        numerator_per_share=Decimal(numerator),
        dividend_yield=Decimal(dividend_yield) if dividend_yield is not None else None,
        latest_price=Decimal(price),
        consecutive_years=consecutive,
        last_dividend_year=last_year if last_year is not None else cur,
        suspicious=suspicious,
        computed_at=datetime.now(tz.utc),
    )
    session.add(snap)
    await session.flush()
    return m, snap


async def _make_admin(session, client) -> dict:
    """注册用户并提升为 admin（require_admin 以 DB 实时 role 为准）。"""
    info = await register_login(client, email="boss@example.com")
    await session.execute(
        update(User).where(User.email == "boss@example.com").values(role="admin")
    )
    await session.commit()
    return info


# ───────────────────────── 参数校验（§9 排序白名单 / 枚举） ─────────────────────────
@pytest.mark.asyncio
async def test_rankings_sort_whitelist_rejects_unknown(session, client):
    """守护 §8.1/§12：sort 白名单外 → 400。"""
    info = await register_login(client)
    r = await client.get("/api/dividend-yield/rankings", params={"sort": "name"}, headers=auth(info["token"]))
    status, code, _, _ = env(r)
    assert status == 400 and code != 0


@pytest.mark.asyncio
async def test_rankings_mode_and_exchange_validation(session, client):
    """守护 §8.1：mode/exchange 非法值 → 400（fail closed）。"""
    info = await register_login(client)
    h = auth(info["token"])
    r = await client.get("/api/dividend-yield/rankings", params={"mode": "BAD"}, headers=h)
    assert env(r)[0] == 400
    r = await client.get("/api/dividend-yield/rankings", params={"exchange": "US"}, headers=h)
    assert env(r)[0] == 400


# ───────────────────────── NULL 不进榜（§3.5） ─────────────────────────
@pytest.mark.asyncio
async def test_rankings_null_yield_excluded(session, client):
    """守护 §3.5/§12：NULL 股息率不进榜。"""
    info = await register_login(client)
    await _seed_snapshot(session, "sh600100", dividend_yield=None)
    await _seed_snapshot(session, "sh600200", dividend_yield="0.08")
    await session.commit()
    r = await client.get("/api/dividend-yield/rankings", headers=auth(info["token"]))
    status, _, data, _ = env(r)
    assert status == 200
    codes = {row["code"] for row in data["items"]}
    assert codes == {"sh600200"}


# ───────────────────────── 近两年无分红默认剔除（§8.2/§8.3，P0-3） ─────────────────────────
@pytest.mark.asyncio
async def test_rankings_excludes_no_recent_dividend_by_default(session, client):
    """守护 §8.2：默认（include_no_dividend=false）剔除近两年无分红公司，可显式关掉。"""
    info = await register_login(client)
    cur = date.today().year
    await _seed_snapshot(session, "sh600101", dividend_yield="0.08", last_year=cur)
    await _seed_snapshot(session, "sh600102", dividend_yield="0.09", last_year=cur - 3)
    await session.commit()
    h = auth(info["token"])
    r = await client.get("/api/dividend-yield/rankings", headers=h)
    codes = {row["code"] for row in env(r)[2]["items"]}
    assert codes == {"sh600101"}  # 僵尸记录默认剔除
    r = await client.get(
        "/api/dividend-yield/rankings", params={"include_no_dividend": "true"}, headers=h
    )
    codes = {row["code"] for row in env(r)[2]["items"]}
    assert codes == {"sh600101", "sh600102"}


# ───────────────────────── min_consecutive / exchange 过滤（§8.1） ─────────────────────────
@pytest.mark.asyncio
async def test_rankings_min_consecutive_and_exchange_filters(session, client):
    """守护 §8.1：min_consecutive 下限与交易所过滤组合。"""
    info = await register_login(client)
    await _seed_snapshot(session, "sh600201", dividend_yield="0.08", consecutive=3, exchange="SH")
    await _seed_snapshot(session, "sz000202", dividend_yield="0.07", consecutive=1, exchange="SZ")
    await session.commit()
    h = auth(info["token"])
    r = await client.get("/api/dividend-yield/rankings", params={"min_consecutive": 2}, headers=h)
    codes = {row["code"] for row in env(r)[2]["items"]}
    assert codes == {"sh600201"}
    r = await client.get("/api/dividend-yield/rankings", params={"exchange": "SZ"}, headers=h)
    codes = {row["code"] for row in env(r)[2]["items"]}
    assert codes == {"sz000202"}


# ───────────────────────── 过滤态股息率现算（§8.1，P0-2） ─────────────────────────
@pytest.mark.asyncio
async def test_rankings_include_proposed_false_recomputes(session, client):
    """守护 §8.1「过滤态股息率」：include_proposed=false 时剔除 PROPOSED 后现算分子，
    行内 filtered=True 且股息率 ≠ 快照值。"""
    info = await register_login(client)
    cur = date.today().year
    m, snap = await _seed_snapshot(
        session, "sh600301", dividend_yield="0.15", numerator="3.0", price="20",
    )
    session.add(SecurityDividend(
        master_id=m.id, report_year=cur - 1, report_quarter=4,
        period_type=ReportPeriodType.ANNUAL,
        cash_per_share=Decimal("1.0"), status=DividendStatus.PAID,
    ))
    session.add(SecurityDividend(
        master_id=m.id, report_year=cur, report_quarter=4,
        period_type=ReportPeriodType.ANNUAL,
        cash_per_share=Decimal("2.0"), status=DividendStatus.PROPOSED,
    ))
    await session.commit()
    h = auth(info["token"])
    r = await client.get(
        "/api/dividend-yield/rankings", params={"include_proposed": "false"}, headers=h
    )
    status, _, data, _ = env(r)
    assert status == 200
    row = data["items"][0]
    assert row["filtered"] is True
    assert Decimal(row["numerator_per_share"]) == Decimal("1.0")  # 仅 PAID 计入
    assert Decimal(row["dividend_yield"]) == Decimal("0.05")  # 1.0 / 20
    # 快照值未被改写（0.15 含预案）
    assert snap.dividend_yield == Decimal("0.15")


# ───────────────────────── /top20 双榜契约（§8.3，P0-3/P0-4） ─────────────────────────
@pytest.mark.asyncio
async def test_top20_double_board_contract(session, client):
    """守护 §8.3：top 剔除 suspicious 与近两年无分红；consecutive 榜 >=2 且
    consecutive_years DESC, dividend_yield DESC 排序；A13 双榜均 ≤20。"""
    info = await register_login(client)
    cur = date.today().year
    await _seed_snapshot(session, "sh600401", dividend_yield="0.09", consecutive=4)  # top ✓
    await _seed_snapshot(session, "sh600402", dividend_yield="0.20", consecutive=5, suspicious=True)  # A12 不入 top
    await _seed_snapshot(session, "sh600403", dividend_yield="0.10", consecutive=2, last_year=cur - 5)  # 僵尸不入 top
    await _seed_snapshot(session, "sh600404", dividend_yield="0.06", consecutive=1)  # 连续 1 年不入榜二
    await _seed_snapshot(session, "sz000405", dividend_yield="0.05", consecutive=3, exchange="SZ")  # top ✓
    await session.commit()
    r = await client.get("/api/dividend-yield/top20", headers=auth(info["token"]))
    status, _, data, _ = env(r)
    assert status == 200
    assert set(data.keys()) == {"top", "consecutive"}
    top_codes = [row["code"] for row in data["top"]]
    assert "sh600401" in top_codes and "sz000405" in top_codes
    assert "sh600402" not in top_codes  # suspicious 剔除
    assert "sh600403" not in top_codes  # 近两年无分红剔除
    cons = data["consecutive"]
    cons_codes = [row["code"] for row in cons]
    assert "sh600402" in cons_codes  # 榜二无 A12 过滤（含 suspicious，按 §8.3 字面）
    assert "sh600404" not in cons_codes  # consecutive_years=1 不入榜二
    cy = [row["consecutive_years"] for row in cons]
    assert cy == sorted(cy, reverse=True)  # consecutive_years DESC


# ───────────────────────── settings：非 admin 403（§12） ─────────────────────────
@pytest.mark.asyncio
async def test_settings_requires_admin(session, client):
    """守护 §9/§12：非 admin GET/PUT /settings → 403。"""
    info = await register_login(client)
    h = auth(info["token"])
    assert (await client.get("/api/dividend-yield/settings", headers=h)).status_code == 403
    r = await client.put(
        "/api/dividend-yield/settings",
        json={"green_threshold": "0.05", "red_threshold": "0.03"},
        headers=h,
    )
    assert r.status_code == 403


# ───────────────────────── settings PUT：阈值 + 四重校验（§5.4，P1-4） ─────────────────────────
async def _seed_category3_interfaces(session):
    """分类 3 + 主源（无 symbol）/ 补充源（含 symbol）两接口行，供四重校验测试。"""
    session.add(InterfaceCategory(id=_DIVIDEND_CAT_ID, label="股息列表", system=True))
    provider = SecuritiesDataProvider(
        id=_uid(), name="akshare", access_method=QuoteProviderAccessMethod.SDK,
        config={}, enabled=True,
    )
    session.add(provider)
    await session.flush()
    main_itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=_DIVIDEND_CAT_ID,
        name="东财-分红配送", endpoint="stock_fhps_em", enabled=True,
        params={"date": "20231231"},
    )
    detail_itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=_DIVIDEND_CAT_ID,
        name="新浪-分红配股", endpoint="stock_history_dividend_detail", enabled=True,
        params={"symbol": "600012", "indicator": "分红"},
    )
    session.add_all([main_itf, detail_itf])
    await session.commit()
    return main_itf, detail_itf


@pytest.mark.asyncio
async def test_settings_put_threshold_validation(session, client):
    """守护 §5.4/§12：阈值 0 < red < green <= 1，违规 400 不落库。"""
    admin = await _make_admin(session, client)
    h = auth(admin["token"])
    r = await client.put(
        "/api/dividend-yield/settings",
        json={"green_threshold": "0.03", "red_threshold": "0.05"},  # red >= green
        headers=h,
    )
    assert r.status_code == 400
    r = await client.put(
        "/api/dividend-yield/settings",
        json={"green_threshold": "1.2", "red_threshold": "0.03"},  # green > 1
        headers=h,
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_settings_put_interface_shape_validation(session, client):
    """守护 §5.4 四重校验（P1-4）：主源选逐只接口（params 含 symbol）→ 400；
    主源/补充源各归其位 → 200。"""
    admin = await _make_admin(session, client)
    main_itf, detail_itf = await _seed_category3_interfaces(session)
    h = auth(admin["token"])

    # 主源误选「逐只」形态接口 → 400
    r = await client.put(
        "/api/dividend-yield/settings",
        json={
            "green_threshold": "0.05", "red_threshold": "0.03",
            "dividend_report_source_interface_id": detail_itf.id,
        },
        headers=h,
    )
    assert r.status_code == 400

    # 补充源误选「按报告期全量」接口 → 400
    r = await client.put(
        "/api/dividend-yield/settings",
        json={
            "green_threshold": "0.05", "red_threshold": "0.03",
            "dividend_detail_source_interface_id": main_itf.id,
        },
        headers=h,
    )
    assert r.status_code == 400

    # 各归其位 → 200 落库
    r = await client.put(
        "/api/dividend-yield/settings",
        json={
            "green_threshold": "0.05", "red_threshold": "0.03",
            "dividend_report_source_interface_id": main_itf.id,
            "dividend_detail_source_interface_id": detail_itf.id,
        },
        headers=h,
    )
    status, _, data, _ = env(r)
    assert status == 200
    assert data["dividend_report_source"]["id"] == main_itf.id
    assert data["dividend_detail_source"]["id"] == detail_itf.id


# ───────────────────────── 可排序列扩到 5 列（§8.1，P2-6） ─────────────────────────
@pytest.mark.asyncio
async def test_rankings_sort_by_numerator_and_mode_fixed_order(session, client):
    """守护 §8.1：numerator_per_share/latest_price 可排序；mode 列为 TTM 优先固定序（非字典序）。"""
    info = await register_login(client)
    await _seed_snapshot(session, "sh600601", dividend_yield="0.08", mode=DividendYieldMode.LFY, numerator="2.0")
    await _seed_snapshot(session, "sh600602", dividend_yield="0.07", mode=DividendYieldMode.TTM, numerator="1.0")
    await session.commit()
    h = auth(info["token"])
    r = await client.get("/api/dividend-yield/rankings", params={"sort": "numerator_per_share"}, headers=h)
    nums = [row["numerator_per_share"] for row in env(r)[2]["items"]]
    assert Decimal(nums[0]) == Decimal("2.0")  # 分子降序
    r = await client.get("/api/dividend-yield/rankings", params={"sort": "latest_price"}, headers=h)
    assert env(r)[0] == 200
    r = await client.get("/api/dividend-yield/rankings", params={"sort": "mode"}, headers=h)
    modes = [row["mode"] for row in env(r)[2]["items"]]
    assert modes[0] == "TTM" and modes[-1] == "LFY"  # TTM 优先固定序


# ───────────────────────── 曲线 / 反推价格路由契约（§9，P0-1） ─────────────────────────
@pytest.mark.asyncio
async def test_curve_route_segment_order(session, client):
    """守护 §9/P0-1：曲线路由为 /{master_id}/curve（段序：id 在前）。

    同时断言前端曾写反的 /curve/{master_id} 形态 404——段序回归即拦。
    """
    info = await register_login(client)
    m, _ = await _seed_snapshot(session, "sh600701")
    from datetime import timedelta as _td

    session.add(MarketSecurityDailyPrice(
        master_id=m.id, trade_date=date.today() - _td(days=1), close=Decimal("12.5"),
    ))
    await session.commit()
    h = auth(info["token"])

    r = await client.get(f"/api/dividend-yield/{m.id}/curve", headers=h)
    status, _, data, _ = env(r)
    assert status == 200
    assert data["master_id"] == m.id and data["code"] == "sh600701"
    assert len(data["items"]) == 1
    assert {"trade_date", "close", "numerator_per_share", "dividend_yield", "mode"} <= set(data["items"][0])

    # 段序写反（前端历史 bug 形态）必须 404
    wrong = await client.get(f"/api/dividend-yield/curve/{m.id}", headers=h)
    assert wrong.status_code == 404


@pytest.mark.asyncio
async def test_curve_unknown_master_404(session, client):
    """守护 §9：证券与快照均不存在 → 404。"""
    info = await register_login(client)
    r = await client.get(f"/api/dividend-yield/{_uid()}/curve", headers=auth(info["token"]))
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_implied_price_route_segment_order(session, client):
    """守护 §9/P0-1：反推价格路由为 /{master_id}/implied-price；implied = 分子 / target_ratio。

    同时断言段序写反形态 404。
    """
    info = await register_login(client)
    m, snap = await _seed_snapshot(session, "sh600702", numerator="2.0", price="12.5")
    await session.commit()
    h = auth(info["token"])

    r = await client.get(
        f"/api/dividend-yield/{m.id}/implied-price",
        params={"target_ratio": "0.04"}, headers=h,
    )
    status, _, data, _ = env(r)
    assert status == 200
    assert Decimal(data["numerator_per_share"]) == Decimal("2.0")
    assert Decimal(data["implied_price"]) == Decimal("50")  # 2.0 / 0.04
    assert Decimal(data["current_price"]) == Decimal("12.5")

    wrong = await client.get(
        f"/api/dividend-yield/implied-price/{m.id}",
        params={"target_ratio": "0.04"}, headers=h,
    )
    assert wrong.status_code == 404
