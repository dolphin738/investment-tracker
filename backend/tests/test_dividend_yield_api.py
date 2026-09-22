"""股息率排名 API 路由层测试（守护方案 §8/§9/§12）。

覆盖审查报告 P0-2/P0-3/P0-4 与 §12「API/配置」项：
排序白名单 400、NULL 股息率不进榜、近两年无分红默认剔除（§8.2/§8.3）、
``include_proposed=false`` 过滤态股息率现算（§8.1）、min_consecutive / exchange 过滤、
/top20 双榜契约（suspicious + 僵尸剔除、consecutive >= 2、A13）、
settings 阈值校验与接口四重校验 400（§5.4）、非 admin 403。
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import date, datetime, timezone as tz
from decimal import Decimal

import pytest
from sqlalchemy import update

from app.models import (
    InterfaceCategory,
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
from app.services.market_data_sync import (
    DIVIDEND_LIST_CAT_ID,
    NOTICE_CAT_ID,
    QUOTE_CAT_ID,
)
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


# ───────────────────────── settings：GET 登录可读，PUT admin-only（§9，P1-1） ─────────────────────────
@pytest.mark.asyncio
async def test_settings_put_requires_admin(session, client):
    """守护 §9/P1-1：GET /settings 登录即可读；PUT 仍 admin-only 403。阈值已迁用户偏好（0026）。"""
    info = await register_login(client)
    h = auth(info["token"])
    assert (await client.get("/api/dividend-yield/settings", headers=h)).status_code == 200
    r = await client.put(
        "/api/dividend-yield/settings",
        json={},
        headers=h,
    )
    assert r.status_code == 403


# ───────────────────────── settings PUT：接口四重校验（§5.4，P1-4） ─────────────────────────
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


async def _seed_category4_interface(session, *, enabled: bool = True):
    """分类 4「公司公告」+ 公告接口行（params 含 symbol，逐只形态），供公告源校验测试。"""
    session.add(InterfaceCategory(id=NOTICE_CAT_ID, label="公司公告", system=True))
    provider = SecuritiesDataProvider(
        id=_uid(), name="akshare", access_method=QuoteProviderAccessMethod.SDK,
        config={}, enabled=True,
    )
    session.add(provider)
    await session.flush()
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=NOTICE_CAT_ID,
        name="沪深京 A 股公告", endpoint="stock_notice_report", enabled=enabled,
        params={"symbol": "财务报告", "date": "20260907"},
    )
    session.add(itf)
    await session.commit()
    return itf


async def _seed_quote_per_symbol_interface(session):
    """分类 2「证券行情」+ 逐只形态行情接口（params 含 symbol），供行情源形态校验测试。

    正常行情源应为「按报告期全量」（params 无 symbol）；此处故意造逐只形态的行情接口，
    用于断言 require_per_symbol=False 分支的错误提示（修复回归守护）。
    """
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    provider = SecuritiesDataProvider(
        id=_uid(), name="akshare", access_method=QuoteProviderAccessMethod.SDK,
        config={}, enabled=True,
    )
    session.add(provider)
    await session.flush()
    itf = QuoteInterface(
        id=_uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID,
        name="逐只行情-误配", endpoint="stock_zh_a_hist", enabled=True,
        params={"symbol": "600012"},
    )
    session.add(itf)
    await session.commit()
    return itf


@pytest.mark.asyncio
async def test_settings_put_interface_shape_validation(session, client):
    """守护 §5.4 四重校验（P1-4）+ 形态错误提示按源动态生成（两种错配各提示各自要求）：
    股息明细源接口（require_per_symbol=True）误选「按报告期全量」→ 400，提示「须为按证券逐只」；
    行情源（require_per_symbol=False）误选「按证券逐只」→ 400，提示「须为按报告期全量」；
    股息明细源接口为逐只形态 → 200。"""
    admin = await _make_admin(session, client)
    main_itf, detail_itf = await _seed_category3_interfaces(session)
    quote_itf = await _seed_quote_per_symbol_interface(session)
    h = auth(admin["token"])

    # 分支一（require_per_symbol=True）：股息明细源接口误选「按报告期全量」接口 → 400
    r = await client.put(
        "/api/dividend-yield/settings",
        json={
            "dividend_detail_source_interface_id": main_itf.id,
        },
        headers=h,
    )
    status, _, _, message = env(r)
    assert status == 400
    assert message == "接口调用形态不符：股息明细源接口须为按证券逐只接口（params 含 symbol）"

    # 分支二（require_per_symbol=False）：行情源误选「按证券逐只」接口 → 400
    r = await client.put(
        "/api/dividend-yield/settings",
        json={
            "price_source_interface_id": quote_itf.id,
        },
        headers=h,
    )
    status, _, _, message = env(r)
    assert status == 400
    assert message == "接口调用形态不符：行情源须为按报告期全量接口（params 无 symbol）"

    # 各归其位 → 200 落库
    r = await client.put(
        "/api/dividend-yield/settings",
        json={
            "dividend_detail_source_interface_id": detail_itf.id,
        },
        headers=h,
    )
    status, _, data, _ = env(r)
    assert status == 200
    assert data["dividend_detail_source"]["id"] == detail_itf.id


# ───────────────────────── 公告源可配置化（§15.3 T1 / §5.4） ─────────────────────────
@pytest.mark.asyncio
async def test_settings_put_announcement_source_valid(session, client):
    """守护 §15.3 T1/§5.4：PUT 合法公告源（分类 4 + enabled + 逐只形态）→ 200，
    响应含 announcement_source {id, name}。"""
    admin = await _make_admin(session, client)
    itf = await _seed_category4_interface(session)
    h = auth(admin["token"])
    r = await client.put(
        "/api/dividend-yield/settings",
        json={
            "announcement_source_interface_id": itf.id,
        },
        headers=h,
    )
    status, _, data, _ = env(r)
    assert status == 200
    assert data["announcement_source"] == {"id": itf.id, "name": "沪深京 A 股公告"}


@pytest.mark.asyncio
async def test_settings_put_announcement_source_wrong_category(session, client):
    """守护 §15.3 T1/§5.4：公告源填分类 3 接口 → 400，message 含「分类不符」。"""
    admin = await _make_admin(session, client)
    main_itf, _ = await _seed_category3_interfaces(session)
    h = auth(admin["token"])
    r = await client.put(
        "/api/dividend-yield/settings",
        json={
            "announcement_source_interface_id": main_itf.id,
        },
        headers=h,
    )
    status, _, _, message = env(r)
    assert status == 400
    assert "分类不符" in message


@pytest.mark.asyncio
async def test_settings_put_announcement_source_disabled(session, client):
    """守护 §15.3 T1/§5.4：公告源未启用 → 400（fail closed 不落库）。"""
    admin = await _make_admin(session, client)
    itf = await _seed_category4_interface(session, enabled=False)
    h = auth(admin["token"])
    r = await client.put(
        "/api/dividend-yield/settings",
        json={
            "announcement_source_interface_id": itf.id,
        },
        headers=h,
    )
    status, _, _, message = env(r)
    assert status == 400
    assert "未启用" in message


@pytest.mark.asyncio
async def test_settings_get_announcement_source_null_by_default(session, client):
    """守护 §15.3 T1：GET /settings 未配置公告源时 announcement_source 为 null（契约扩展键）。"""
    info = await register_login(client)
    r = await client.get("/api/dividend-yield/settings", headers=auth(info["token"]))
    status, _, data, _ = env(r)
    assert status == 200
    assert data["announcement_source"] is None


# ───────────────────────── 留存窗年数（D-4 配置化） ─────────────────────────
@pytest.mark.asyncio
async def test_settings_retention_years_default_and_update(session, client):
    """D-4：GET 默认返回 5；PUT 合法值落库并回显；越界 400。"""
    admin = await _make_admin(session, client)
    h = auth(admin["token"])
    # GET 默认（无配置行）→ 回落默认 5
    status, _, data, _ = env(await client.get("/api/dividend-yield/settings", headers=h))
    assert status == 200
    assert data["dividend_retention_years"] == 5

    # 合法值 → 200 并回显
    status, _, data, _ = env(await client.put(
        "/api/dividend-yield/settings", json={"dividend_retention_years": 3}, headers=h
    ))
    assert status == 200
    assert data["dividend_retention_years"] == 3

    # 越界 → 400（范围 1~10）
    r = await client.put(
        "/api/dividend-yield/settings", json={"dividend_retention_years": 11}, headers=h
    )
    assert env(r)[0] == 400


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


# ───────────────────────── 反推价格路由契约（§9，P0-1） ─────────────────────────
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


# ───────────────────────── 手动全量重建端点（替代系统定时任务 DIVIDEND_YIELD_REBUILD） ─────────────────────────
@pytest.mark.asyncio
async def test_rebuild_requires_admin(session, client):
    """守护重建端点：普通登录用户 → 403 FORBIDDEN（admin-only，require_admin 以 DB 实时 role 为准）。"""
    info = await register_login(client)
    r = await client.post("/api/dividend-yield/rebuild", headers=auth(info["token"]))
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_rebuild_requires_auth(session, client):
    """守护重建端点：缺令牌 → 401（统一鉴权拦截先于角色判断）。"""
    r = await client.post("/api/dividend-yield/rebuild")
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_rebuild_admin_success_returns_summary(session, client):
    """守护重建端点：admin → 200 并返回重建摘要（含受影响证券只数）。

    重建在独立会话内执行并提交；验证端点编排 run_dividend_yield_rebuild
    不抛错，且 summary 反映已 seed 的证券（反推 count 口径）。
    """
    admin = await _make_admin(session, client)
    h = auth(admin["token"])
    # seed 一只证券 + 一条分红，使重建统计非 0，校验 summary 含只数
    m, _ = await _seed_snapshot(session, "sh600901", dividend_yield="0.08")
    session.add(SecurityDividend(
        master_id=m.id, report_year=date.today().year, report_quarter=4,
        period_type=ReportPeriodType.ANNUAL,
        cash_per_share=Decimal("1.0"), status=DividendStatus.PAID,
    ))
    await session.commit()
    r = await client.post("/api/dividend-yield/rebuild", headers=h)
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert isinstance(data["summary"], str)
    assert data["summary"].startswith("股息率全量重建完成")
    assert "1 只" in data["summary"]


@pytest.mark.asyncio
async def test_rebuild_preserves_snapshot_without_raw_source(session, client):
    """守护重建边界（修复点）：仅存在有值快照、无原始分红/价格时，重建应保留既有派生值，

    而非把有值快照覆写为 None（否则表面「0 只」实为数据丢失）。summary 计入口径改为「保留 N 只」。
    """
    admin = await _make_admin(session, client)
    h = auth(admin["token"])
    # 直接造一条有值的快照，但不造原始分红 / 价格
    m = Security(
        id=_uid(), code="sh600902", name="证券sh600902",
        asset_class=SecurityType.STOCK, exchange="SH",
    )
    session.add(m)
    snap = SecurityDividendYield(
        master_id=m.id, mode=DividendYieldMode.TTM,
        numerator_per_share=Decimal("1.0"), dividend_yield=Decimal("0.08"),
        latest_price=Decimal("12.5"), consecutive_years=3,
        last_dividend_year=date.today().year, computed_at=datetime.now(tz.utc),
    )
    session.add(snap)
    await session.commit()
    r = await client.post("/api/dividend-yield/rebuild", headers=h)
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert "保留 1 只" in data["summary"]
    # 快照值未被覆写
    await session.refresh(snap)
    assert snap.dividend_yield == Decimal("0.08")


# ───────────────────────── NaN 进榜守卫（§3.5 / 迁移 0010，审查 M-1） ─────────────────────────
@pytest.mark.asyncio
async def test_rankings_excludes_numeric_nan_snapshot(session, client):
    """守护 §3.5：PG numeric NaN 视为「缺失」，不进榜（IS NOT NULL 拦不住 NaN）。

    NaN 在 PG numeric 中**等于自身且大于所有其他值**，旧守卫 ``IS NOT NULL`` 对其失效，
    导致 NaN 行混入榜单并在降序排序中霸占榜首、前端渲染为 "-"
    （2026-09-08 排查 600339：121 行快照受影响）。本用例是「守卫层」回归护栏。
    """
    info = await register_login(client)
    h = auth(info["token"])
    await _seed_snapshot(session, "sh600910", dividend_yield="0.05")  # 正常 ✓
    await _seed_snapshot(session, "sh600911", dividend_yield="NaN")  # NaN ✗
    await _seed_snapshot(session, "sh600912", dividend_yield="0.09")  # 正常 ✓
    await session.commit()

    r = await client.get("/api/dividend-yield/rankings", headers=h)
    status, _, data, _ = env(r)
    assert status == 200
    codes = [row["code"] for row in data["items"]]
    assert "sh600910" in codes and "sh600912" in codes
    assert "sh600911" not in codes, "numeric NaN 快照不得进榜（§3.5 缺失语义）"
    # 降序时 NaN 被视为最大值，若守卫失效它会占据首位——故断言首位是正常最大值
    assert codes[0] == "sh600912"


@pytest.mark.asyncio
async def test_top20_excludes_numeric_nan_snapshot(session, client):
    """守护 §8.2/§8.3：Top20 与连续分红榜同样排除 NaN（与 rank 同一口径）。"""
    info = await register_login(client)
    cur = date.today().year
    await _seed_snapshot(session, "sh600920", dividend_yield="0.05", consecutive=3)
    await _seed_snapshot(
        session, "sh600921", dividend_yield="NaN", consecutive=5, suspicious=False
    )  # NaN：即便连续年数最高也不应入榜
    await _seed_snapshot(
        session, "sh600922", dividend_yield="0.07", consecutive=2,
        last_year=cur - 3,
    )  # 连续榜候选（Top 榜因近两年无分红被剔除）
    await session.commit()

    r = await client.get("/api/dividend-yield/top20", headers=auth(info["token"]))
    status, _, data, _ = env(r)
    assert status == 200
    top_codes = [row["code"] for row in data["top"]]
    cons_codes = [row["code"] for row in data["consecutive"]]
    assert "sh600921" not in top_codes, "NaN 不得进 Top 榜"
    assert "sh600921" not in cons_codes, "NaN 不得进连续分红榜"


# ───────────────────────── /seed-initial-dividends 端点契约（§5.7 / §4.6） ─────────────────────────
@pytest.mark.asyncio
async def test_seed_requires_admin(session, client):
    """守护 §5.7：未登录 401、非 admin 403（与 /rebuild 同口径）。"""
    # 未登录
    r = await client.post("/api/dividend-yield/seed-initial-dividends")
    assert r.status_code == 401
    # 已登录非 admin
    info = await register_login(client)
    r = await client.post(
        "/api/dividend-yield/seed-initial-dividends", headers=auth(info["token"])
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_seed_triggers_job_async(session, client, monkeypatch):
    """守护 §5.7：admin 触发成功 → 200，且 fire-and-forget 直接调起播种服务。

    ``run_dividend_seed`` 被替换为即时桩：真实链路串行遍历全市场约 11430 只（约 19 小时），
    测试中绝不可真实执行；契约关注点是「立即返回 + 后台确实被调起」。

    **patch 目标**：``_run_seed()`` 在**函数体内** ``from app.services.dividend_seed import
    run_dividend_seed``（延迟导入，装配期不拉起引擎），因此必须打在模块属性
    ``app.services.dividend_seed.run_dividend_seed`` 上；打在 trigger_router 模块上无效
    （该模块没有这个名字），断言会退化成假通过。
    """
    import app.services.dividend_seed as seed_mod

    captured: list = []
    # 即时桩：记录被调用的 cfg（应为 None），返回占位摘要
    async def _noop(cfg):
        captured.append(cfg)
        return "noop"

    monkeypatch.setattr(seed_mod, "run_dividend_seed", _noop)

    admin = await _make_admin(session, client)
    h = auth(admin["token"])
    r = await client.post("/api/dividend-yield/seed-initial-dividends", headers=h)
    status, _, data, _ = env(r)
    assert status == 200
    assert "后台执行" in data["message"]
    # §4.4 契约漂移：后端从不返回 job_id（播种不注册 JobType、无 job_task 行可对应），
    # 前端旧声明里的 job_id 不得复辟。
    assert "job_id" not in data

    # 等待 fire-and-forget 任务被调度（track_task + asyncio.create_task，同 /backfill-prices 契约）
    for _ in range(50):
        if captured:
            break
        await asyncio.sleep(0.01)
    assert captured, "须以 fire-and-forget 调起 run_dividend_seed(None)"
    assert captured[0] is None, "按钮版直接调用服务函数，不再经系统任务 cfg"


# ───────────────────────── 播种单飞锁（行动项 8，§6.2） ─────────────────────────
@pytest.mark.asyncio
async def test_seed_single_flight_rejects_concurrent(session, client, monkeypatch):
    """行动项 8（§6.2）：播种单飞——已在运行中再次触发 → 409，且后台任务只被创建一次。

    用 ``asyncio.Event`` 让桩播种「挂住」以保持锁被持有；期间第二次触发须被拒（409）而非
    再起一个任务（否则连点会并发启动多个 19h 任务、双倍打满 rate_limit 预算）。释放后锁
    须复位（``_run_seed`` 的 finally 保证），避免一次失败把播种永久锁死。

    **测试隔离**：用 monkeypatch 把模块级 ``_seed_lock`` 换成全新锁，避免与其它用例残留
    的锁状态相互污染（monkeypatch 结束后自动还原）。
    """
    import asyncio as _asyncio

    import app.services.dividend_seed as seed_mod
    import app.modules.dividend_yield.trigger_router as bf

    monkeypatch.setattr(bf, "_seed_lock", _asyncio.Lock())

    started = _asyncio.Event()
    release = _asyncio.Event()
    calls = {"n": 0}

    async def _blocking(cfg):
        calls["n"] += 1
        started.set()
        await release.wait()
        return "noop"

    monkeypatch.setattr(seed_mod, "run_dividend_seed", _blocking)

    admin = await _make_admin(session, client)
    h = auth(admin["token"])

    r1 = await client.post("/api/dividend-yield/seed-initial-dividends", headers=h)
    status1, _, data1, _ = env(r1)
    assert status1 == 200 and "后台执行" in data1["message"]
    # 后台任务确实起来了（锁已被持有）
    await _asyncio.wait_for(started.wait(), timeout=2)

    # 已在运行 → 第二次触发 409，且不新建任务
    r2 = await client.post("/api/dividend-yield/seed-initial-dividends", headers=h)
    status2, _, _, msg2 = env(r2)
    assert status2 == 409, r2.text
    assert "已有播种任务在运行" in msg2
    assert calls["n"] == 1, "单飞锁须阻止第二个播种任务被调起"

    # 释放后台任务 → 锁须复位（finally 释放）
    release.set()
    for _ in range(200):
        if not bf._seed_lock.locked():
            break
        await _asyncio.sleep(0.01)
    assert not bf._seed_lock.locked(), "播种结束后单飞锁须释放（否则播种被永久锁死）"


