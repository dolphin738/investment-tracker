"""股票列表和测试 — 后端前置依赖集成测试（§7 ① ② ③）。

覆盖：
- GET  /api/admin/securities/masters：分页 + q 搜索（code / name / 拼音首字母）；仅返回 portfolio_id IS NULL 主数据行。
- POST /api/admin/securities/sync：触发 sync_all_security_masters（这里以无 MASTER_LIST 接口 → synced=0 验证契约）。
- POST /api/admin/quote-interfaces/{id}/test：单接口测试回传 raw + parsed（monkeypatch 网络）。
- POST /api/portfolios/{pid}/securities/resolve：幂等 upsert by (portfolio_id, code)
  （命中组合行 → isNew=false；以主数据行模板 → isNew=true；兜底请求体 → isNew=true）。

测试库在会话内共享，_clean_db 每个测试前 TRUNCATE 全部表（含迁移种子，故测试内自行创建数据）。
"""
from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy import select

import app.db.database as dbmod
from app.core.security import create_access_token
from app.models import InterfaceCategory, Portfolio, PortfolioSecurity, Security, User
from app.models.enums import SecurityType
from app.services.market_data_sync import (
    MASTER_LIST_CAT_ID,
    QUOTE_CAT_ID,
    MarketDataSyncService,
    _infer_exchange,
    master_id_for,
)

from tests.helpers import auth, env, register_login

pytestmark = pytest.mark.asyncio

PROVIDER_BODY = {
    "name": "测试提供方",
    "access_method": "https",
    "config": {"base_url": "https://api.example.com"},
    "enabled": True,
}

INTERFACE_BASE = {
    "name": "测试接口",
    "endpoint": "/api/test",
    "http_method": "GET",
    "params": {"code": "string"},
    "enabled": True,
    "resp_code_field": "code",
    "resp_price_field": "price",
}


async def _admin_token(client, email: str) -> str:
    creds = await register_login(client, email=email, password="pw123456")
    async with dbmod.AsyncSessionLocal() as s:
        u = (
            await s.execute(select(User).where(User.id == creds["user_id"]))
        ).scalar_one()
        u.role = "admin"
        await s.commit()
    return create_access_token(creds["user_id"], creds["email"], "admin")


async def _create_provider(client, token: str, name: str = "测试提供方") -> str:
    body = dict(PROVIDER_BODY, name=name)
    r = await client.post("/api/admin/quote-providers", json=body, headers=auth(token))
    return env(r)[2]["id"]


async def _create_category(client, token: str, label: str = "分类") -> str:
    r = await client.post(
        "/api/admin/interface-categories", json={"label": label}, headers=auth(token)
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0, data
    return data["id"]


async def _create_interface(
    client, token: str, provider_id: str, category_id: str, **overrides
) -> str:
    body = {**INTERFACE_BASE, "category_id": category_id, **overrides}
    r = await client.post(
        f"/api/admin/quote-providers/{provider_id}/interfaces",
        json=body,
        headers=auth(token),
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0, data
    return data["id"]


async def _seed_fixed_categories(session):
    """按迁移种子重建 2 个固定系统分类（_clean_db 会 TRUNCATE，故测试内重建）。

    路由同步引擎按固定 UUID（MASTER_LIST_CAT_ID / QUOTE_CAT_ID）识别「证券列表 /
    证券行情」分类；主数据/行情同步测试须保证对应分类行存在（category_id 为 FK）。
    """
    for cid, label in ((MASTER_LIST_CAT_ID, "证券列表"), (QUOTE_CAT_ID, "证券行情")):
        if await session.get(InterfaceCategory, cid) is None:
            session.add(InterfaceCategory(id=cid, label=label, system=True))
    await session.commit()


async def _seed_master(session, code, name, typ, pinyin, exchange=None):
    sec = Security(
        asset_class=typ,
        code=code,
        name=name,
        pinyin_initials=pinyin,
        exchange=exchange,
    )
    session.add(sec)
    await session.commit()
    return sec


# --------------------------------------------------------------------------- #
# GET /api/admin/securities/masters：分页 + q 搜索
# --------------------------------------------------------------------------- #
async def test_list_security_masters_pagination_and_search(client, session):
    token = await _admin_token(client, "sm_admin_1@example.com")
    await _seed_master(session, "sh600000", "浦发银行", SecurityType.STOCK, "pfyh", "SH")
    await _seed_master(session, "sz000001", "平安银行", SecurityType.STOCK, "payh", "SZ")
    await _seed_master(session, "hk00700", "腾讯控股", SecurityType.HK_STOCK, "txkg", "HK")

    # 分页：第 1 页 2 条
    r = await client.get(
        "/api/admin/securities/masters?page=1&pageSize=2", headers=auth(token)
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["total"] == 3
    assert data["page"] == 1
    assert data["pageSize"] == 2
    assert len(data["items"]) == 2
    # 仅返回主数据行（portfolio_id IS NULL）；shape 含 code/name/exchange/type/updatedAt
    assert {k for k in data["items"][0]} >= {
        "id", "code", "name", "exchange", "assetClass", "updatedAt",
    }

    # q 匹配 code（带交易所前缀，子串仍可命中）
    r = await client.get("/api/admin/securities/masters?q=600000", headers=auth(token))
    _, _, data, _ = env(r)
    assert data["total"] == 1 and data["items"][0]["code"] == "sh600000"

    # q 匹配 name（中文）
    r = await client.get("/api/admin/securities/masters?q=平安", headers=auth(token))
    _, _, data, _ = env(r)
    assert data["total"] == 1 and data["items"][0]["code"] == "sz000001"

    # q 匹配拼音首字母
    r = await client.get("/api/admin/securities/masters?q=pfyh", headers=auth(token))
    _, _, data, _ = env(r)
    assert data["total"] == 1 and data["items"][0]["code"] == "sh600000"


async def test_list_security_masters_filter_by_asset_class_and_stats(client, session):
    """asset_class 过滤参数 + /stats 分类计数端点。"""
    token = await _admin_token(client, "sm_admin_filter@example.com")
    await _seed_master(session, "sh600000", "浦发银行", SecurityType.STOCK, "pfyh", "SH")
    await _seed_master(session, "sz000001", "平安银行", SecurityType.STOCK, "payh", "SZ")
    await _seed_master(session, "hk00700", "腾讯控股", SecurityType.HK_STOCK, "txkg", "HK")

    # 按类别过滤：仅 STOCK
    r = await client.get(
        "/api/admin/securities/masters?asset_class=STOCK", headers=auth(token)
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["total"] == 2
    assert {i["code"] for i in data["items"]} == {"sh600000", "sz000001"}

    # 按类别过滤：仅 HK_STOCK
    r = await client.get(
        "/api/admin/securities/masters?asset_class=HK_STOCK", headers=auth(token)
    )
    _, _, data, _ = env(r)
    assert data["total"] == 1 and data["items"][0]["code"] == "hk00700"

    # 分类计数端点
    r = await client.get("/api/admin/securities/masters/stats", headers=auth(token))
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    counts = data["counts"]
    assert counts.get("STOCK") == 2
    assert counts.get("HK_STOCK") == 1


async def test_list_security_masters_filter_by_exchange(client, session):
    """exchange 过滤参数（SH/SZ/BJ/HK）独立生效，与 asset_class 可叠加。"""
    token = await _admin_token(client, "sm_admin_exch@example.com")
    await _seed_master(session, "sh600000", "浦发银行", SecurityType.STOCK, "pfyh", "SH")
    await _seed_master(session, "sz000001", "平安银行", SecurityType.STOCK, "payh", "SZ")
    await _seed_master(session, "bj920021", "贝特瑞", SecurityType.STOCK, "btr", "BJ")
    await _seed_master(session, "hk00700", "腾讯控股", SecurityType.HK_STOCK, "txkg", "HK")

    # 仅 SH
    r = await client.get(
        "/api/admin/securities/masters?exchange=SH", headers=auth(token)
    )
    _, _, data, _ = env(r)
    assert data["total"] == 1 and data["items"][0]["code"] == "sh600000"

    # 仅 HK
    r = await client.get(
        "/api/admin/securities/masters?exchange=HK", headers=auth(token)
    )
    _, _, data, _ = env(r)
    assert data["total"] == 1 and data["items"][0]["code"] == "hk00700"

    # exchange 与 asset_class 叠加：STOCK + SZ
    r = await client.get(
        "/api/admin/securities/masters?asset_class=STOCK&exchange=SZ",
        headers=auth(token),
    )
    _, _, data, _ = env(r)
    assert data["total"] == 1 and data["items"][0]["code"] == "sz000001"

    # 非法 exchange 值被忽略（不过滤成空）
    r = await client.get(
        "/api/admin/securities/masters?exchange=XXX", headers=auth(token)
    )
    _, _, data, _ = env(r)
    assert data["total"] == 4


async def test_list_security_masters_excludes_portfolio_rows(client, session):
    """主数据端点只返回主数据行（securities 现为纯目录表，无组合行概念）。

    ADR-003：resolve 实例化的是 portfolio_securities 组合持仓，不向 securities 写任何行；
    故 masters 端点始终只返回系统主数据。
    """
    token = await _admin_token(client, "sm_admin_2@example.com")
    # 主数据行
    master = await _seed_master(session, "sh600000", "浦发银行", SecurityType.STOCK, "pfyh", "SH")

    # resolve 出一条组合持仓（不影响 securities 主数据表）
    user, pf = await _user_and_portfolio(session, "sm_pf_user@example.com")
    r = await client.post(
        f"/api/portfolios/{pf.id}/securities/resolve",
        json={"masterId": master.id},
        headers=auth(create_access_token(user.id, user.email, "user")),
    )
    assert env(r)[0] == 200

    r = await client.get("/api/admin/securities/masters", headers=auth(token))
    _, _, data, _ = env(r)
    assert data["total"] == 1
    assert data["items"][0]["code"] == "sh600000"
    assert data["items"][0]["name"] == "浦发银行"  # 主数据行，非组合行


async def test_list_security_masters_allows_any_logged_in_user(client, session):
    """§10 录入界面证券搜索复用 masters 端点：任意登录用户（非仅管理员）可读系统主数据。

    主数据行是系统级公共字典（portfolio_id IS NULL），不含用户私有数据，
    故该端点从 require_admin 放宽为登录即可（同步/测试端点仍仅限管理员）。
    """
    creds = await register_login(client, email="sm_user_1@example.com", password="pw123456")
    token = create_access_token(creds["user_id"], creds["email"], "user")
    r = await client.get("/api/admin/securities/masters", headers=auth(token))
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert "items" in data and "total" in data


# --------------------------------------------------------------------------- #
# POST /api/admin/securities/sync：触发主数据同步（契约）
# --------------------------------------------------------------------------- #
async def test_sync_security_masters_no_master_interfaces(client, session):
    """无 MASTER_LIST 接口时 sync_all_security_masters 返回 synced=0（契约不被破坏）。"""
    token = await _admin_token(client, "sm_admin_3@example.com")
    r = await client.post("/api/admin/securities/sync", headers=auth(token))
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["synced"] == 0
    assert data["failed"] == 0
    assert isinstance(data["errors"], list)


# --------------------------------------------------------------------------- #
# POST /api/admin/quote-interfaces/{id}/test：单接口测试回传 raw+parsed
# --------------------------------------------------------------------------- #
async def test_quote_interface_test_returns_raw_and_parsed(client, monkeypatch, session):
    token = await _admin_token(client, "sm_admin_4@example.com")
    pid = await _create_provider(client, token)
    cid = await _create_category(client, token)
    iid = await _create_interface(client, token, pid, cid, name="测试行情接口")

    async def _fake_raw(self, itf, params, codes):
        return [
            {"code": "600000", "price": "12.34"},
            {"code": "000001", "price": "9.87"},
        ]

    monkeypatch.setattr(MarketDataSyncService, "_call_interface_raw", _fake_raw)

    r = await client.post(
        f"/api/admin/quote-interfaces/{iid}/test",
        json={"params": {"a": "b"}, "codes": ["600000"]},
        headers=auth(token),
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["ok"] is True
    assert data["status"] == "success"
    assert data["interfaceId"] == iid
    assert data["raw"] == [
        {"code": "600000", "price": "12.34"},
        {"code": "000001", "price": "9.87"},
    ]
    assert data["parsed"] == {"sh600000": "12.34", "sz000001": "9.87"}
    assert data["elapsedMs"] >= 0
    assert "error" not in data or data.get("error") is None


async def test_quote_interface_test_error_not_found(client, session):
    token = await _admin_token(client, "sm_admin_5@example.com")
    r = await client.post(
        "/api/admin/quote-interfaces/00000000-0000-0000-0000-000000000000/test",
        json={"params": {}},
        headers=auth(token),
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["ok"] is False
    assert data["status"] == "error"
    assert data["error"] == "接口不存在"


# --------------------------------------------------------------------------- #
# POST /api/portfolios/{pid}/securities/resolve：幂等 upsert
# --------------------------------------------------------------------------- #
async def _user_and_portfolio(session, email: str):
    user = User(id=str(uuid.uuid4()), email=email, password_hash="x", role="user")
    session.add(user)
    await session.flush()
    pf = Portfolio(id=str(uuid.uuid4()), user_id=user.id, name="P")
    session.add(pf)
    await session.commit()
    return user, pf


async def test_resolve_returns_existing_portfolio_row(client, session):
    user, pf = await _user_and_portfolio(session, "res1@example.com")
    master = Security(
        id=str(uuid.uuid4()), asset_class=SecurityType.STOCK,
        code="600000", name="浦发银行", exchange="SH",
        pinyin_initials="pfyh",
    )
    session.add(master)
    await session.flush()
    holding = PortfolioSecurity(
        id=str(uuid.uuid4()), portfolio_id=pf.id, master_id=master.id,
        type=SecurityType.STOCK,
    )
    session.add(holding)
    await session.commit()
    token = create_access_token(user.id, user.email, "user")

    r = await client.post(
        f"/api/portfolios/{pf.id}/securities/resolve",
        json={"masterId": master.id},
        headers=auth(token),
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["id"] == holding.id  # 命中已有组合行，返回同一 id
    assert data["isNew"] is False
    assert data["code"] == "600000"
    assert data["type"] == "STOCK"
    assert data["exchange"] == "SH"


async def test_resolve_creates_from_master_row(client, session):
    user, pf = await _user_and_portfolio(session, "res2@example.com")
    master = Security(
        id=str(uuid.uuid4()), asset_class=SecurityType.STOCK,
        code="600519", name="贵州茅台", exchange="SH",
        pinyin_initials="gzm",
    )
    session.add(master)
    await session.commit()
    token = create_access_token(user.id, user.email, "user")

    r = await client.post(
        f"/api/portfolios/{pf.id}/securities/resolve",
        json={"masterId": master.id},
        headers=auth(token),
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["isNew"] is True
    assert data["id"] != master.id  # 新建组合行（不污染主数据）
    assert data["code"] == "600519"
    assert data["name"] == "贵州茅台"  # 复制自主数据
    assert data["exchange"] == "SH"
    assert data["type"] == "STOCK"


async def test_resolve_fallback_from_request_body(client, session):
    """D2（SEC-INC-04）：resolve 必须指定已存在的主数据 masterId，禁止手输 code 兜底新建。

    主数据无该 masterId 时 → 404（NOT_FOUND），不再按请求体兜底创建组合行。
    """
    user, pf = await _user_and_portfolio(session, "res3@example.com")
    token = create_access_token(user.id, user.email, "user")

    r = await client.post(
        f"/api/portfolios/{pf.id}/securities/resolve",
        json={"masterId": str(uuid.uuid4())},  # 不存在的主数据
        headers=auth(token),
    )
    status, code, _, _ = env(r)
    assert status == 404


async def test_resolve_not_found_for_other_user_portfolio(client, session):
    """组合归属隔离：resolve 他人组合 → 404（不泄露存在性）。"""
    user, pf = await _user_and_portfolio(session, "res4@example.com")
    master = await _seed_master(session, "600000", "浦发银行", SecurityType.STOCK, "pfyh", "SH")
    other = User(id=str(uuid.uuid4()), email="res4b@example.com", password_hash="x", role="user")
    session.add(other)
    await session.commit()
    token = create_access_token(other.id, other.email, "user")
    r = await client.post(
        f"/api/portfolios/{pf.id}/securities/resolve",
        json={"masterId": master.id},
        headers=auth(token),
    )
    status, code, _, _ = env(r)
    assert status == 404


# --------------------------------------------------------------------------- #
# 回归：真实分派路径（access_method 取自所属 provider，QuoteInterface 无该列）
# --------------------------------------------------------------------------- #
async def test_sync_security_masters_dispatch_uses_provider_access_method(
    client, monkeypatch, session
):
    """sync_security_masters 真实分派回归：只 mock 网络层，分派须经 provider 判定 https。

    修复前 _call_interface_raw 直接读 itf.access_method → AttributeError；
    修复后经所属 SecuritiesDataProvider 取用，本用例应正常 upsert 主数据行。
    """
    token = await _admin_token(client, "sm_admin_8@example.com")
    pid = await _create_provider(client, token)  # access_method=https
    await _seed_fixed_categories(session)
    cid = MASTER_LIST_CAT_ID
    # 主数据接口归属「证券列表」固定分类（reform 后按 category_id 路由）
    iid = await _create_interface(
        client,
        token,
        pid,
        cid,
        name="A股主数据",
        asset_class=[SecurityType.STOCK.value],
    )

    async def _fake_https_raw(self, itf, params, codes):
        return [
            {"code": "600000", "name": "浦发银行"},
            {"code": "000001", "name": "平安银行"},
        ]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_https_raw", _fake_https_raw)
    result = await MarketDataSyncService(session).sync_security_masters(
        SecurityType.STOCK
    )
    assert result["synced"] == 2
    assert result["failed"] == 0
    rows = (
        await session.execute(select(Security))
    ).scalars().all()
    assert {r.code for r in rows} == {"sh600000", "sz000001"}


async def test_quote_interface_test_dispatch_uses_provider_access_method(
    client, monkeypatch
):
    """POST /quote-interfaces/{id}/test 真实分派回归：不 mock 分派层，只 mock 网络。"""
    token = await _admin_token(client, "sm_admin_9@example.com")
    pid = await _create_provider(client, token)  # access_method=https
    cid = await _create_category(client, token)
    iid = await _create_interface(client, token, pid, cid, name="测试行情接口")

    async def _fake_https_raw(self, itf, params, codes):
        return [{"code": "600000", "price": "12.34"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_https_raw", _fake_https_raw)
    r = await client.post(
        f"/api/admin/quote-interfaces/{iid}/test",
        json={"params": {"a": "b"}},
        headers=auth(token),
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["ok"] is True
    assert data["parsed"] == {"sh600000": "12.34"}


async def test_quote_interface_create_update_master_list_fields(client):
    """接口 create/update 透传 asset_class/resp_name_field/resp_exchange_field（分类即用途，不再单独传 purpose）。"""
    token = await _admin_token(client, "sm_admin_10@example.com")
    pid = await _create_provider(client, token)
    cid = await _create_category(client, token)

    # create：设 HK_STOCK + 自定义解析字段（reform 后分类即用途，不再单独传 purpose）
    iid = await _create_interface(
        client,
        token,
        pid,
        cid,
        name="港股主数据",
        asset_class=["HK_STOCK"],
        resp_name_field="sec_name",
        resp_exchange_field="market",
    )
    r = await client.get(
        f"/api/admin/quote-providers/interfaces/{iid}", headers=auth(token)
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["asset_class"] == ["HK_STOCK"]
    assert data["resp_name_field"] == "sec_name"
    assert data["resp_exchange_field"] == "market"

    # update：显式改值生效；未提供的字段保持原值（service 约定 None=未提供）
    r = await client.patch(
        f"/api/admin/quote-providers/interfaces/{iid}",
        json={"resp_name_field": "name"},
        headers=auth(token),
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["resp_name_field"] == "name"
    assert data["asset_class"] == ["HK_STOCK"]
    assert data["resp_exchange_field"] == "market"


async def test_sync_security_masters_array_rows_positional(client, monkeypatch, session):
    """小熊同学类数组行响应 [[code,name],...]：resp_* 配下标 0/1，同步落主数据并推断交易所。"""
    token = await _admin_token(client, "sm_admin_11@example.com")
    pid = await _create_provider(client, token)  # https
    await _seed_fixed_categories(session)
    cid = MASTER_LIST_CAT_ID
    iid = await _create_interface(
        client,
        token,
        pid,
        cid,
        name="A股股票列表（数组行）",
        asset_class=["STOCK"],
        resp_code_field="0",
        resp_name_field="1",
    )

    async def _fake_https_raw(self, itf, params, codes):
        return [
            ["sz301141", "中科磁业"],
            ["sh600000", "浦发银行"],
            ["bj920021", "流金科技"],
        ]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_https_raw", _fake_https_raw)
    result = await MarketDataSyncService(session).sync_security_masters(
        SecurityType.STOCK
    )
    assert result["synced"] == 3
    # 本次同步使用的接口及其获取条数（供前端「同步旁展示」）
    assert result["used"] is not None
    assert result["used"]["interfaceId"] == iid
    assert result["used"]["fetched"] == 3
    assert result["used"]["status"] == "ok"
    rows = {
        r.code: r
        for r in (
            await session.execute(select(Security))
        ).scalars().all()
    }
    # code 统一为「交易所前缀 + 数字」，exchange 由原始 code 前缀推断
    assert rows["sz301141"].name == "中科磁业"
    assert rows["sz301141"].exchange == "SZ"  # sz 前缀推断
    assert rows["sh600000"].name == "浦发银行"
    assert rows["sh600000"].exchange == "SH"
    assert rows["bj920021"].exchange == "BJ"
    assert rows["sh600000"].pinyin_initials == "pfyh"  # 浦发银行 → pfyh


async def test_sync_all_security_masters_returns_used_per_asset_class(
    client, monkeypatch, session
):
    """sync_all_security_masters 遍历多资产类别时，used 列表按 camelCase interfaceId 读取，不 KeyError。

    回归：去重循环曾误用 u['interface_id']（蛇形键），多资产类别同步会立刻 KeyError。
    本用例建 2 个 MASTER_LIST 接口（STOCK / HK_STOCK 各一）触发 distinct 遍历，
    断言 used 含两接口的 camelCase 信息且按 interfaceId 去重。
    """
    token = await _admin_token(client, "sm_admin_12@example.com")
    pid = await _create_provider(client, token)  # access_method=https
    await _seed_fixed_categories(session)
    iid_stock = await _create_interface(
        client,
        token,
        pid,
        MASTER_LIST_CAT_ID,
        name="A股主数据",
        asset_class=["STOCK"],
    )
    iid_hk = await _create_interface(
        client,
        token,
        pid,
        MASTER_LIST_CAT_ID,
        name="港股主数据",
        asset_class=["HK_STOCK"],
    )

    async def _fake_https_raw(self, itf, params, codes):
        if SecurityType.HK_STOCK.value in (itf.asset_class or []):
            return [{"code": "00700", "name": "腾讯控股"}]
        return [{"code": "600000", "name": "浦发银行"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_https_raw", _fake_https_raw)
    result = await MarketDataSyncService(session).sync_all_security_masters()
    assert result["synced"] == 2
    assert result["failed"] == 0
    used = result["used"]
    assert used is not None and len(used) == 2
    assert {u["interfaceId"] for u in used} == {iid_stock, iid_hk}
    for u in used:
        assert u["providerId"] == pid
        assert u["interfaceName"] in ("A股主数据", "港股主数据")
        assert "providerName" in u and "interfaceId" in u


async def test_sync_all_fetches_multi_asset_interface_once(client, monkeypatch, session):
    """多选优化：服务多个 asset_class 的接口在整轮 sync_all 中只被请求一次。

    回归：多选前每个 asset_class 批次都会把该接口当候选，重复请求同一端点。
    本用例建 1 个 MASTER_LIST 接口服务 [STOCK, HK_STOCK]，断言底层 _fetch_https_raw
    整轮仅被调用 1 次，且两类别行均被正确逐行归类（归 STOCK / HK_STOCK）。
    """
    token = await _admin_token(client, "sm_admin_dedup@example.com")
    pid = await _create_provider(client, token)  # access_method=https
    await _seed_fixed_categories(session)
    await _create_interface(
        client,
        token,
        pid,
        MASTER_LIST_CAT_ID,
        name="A股_港股主数据",
        asset_class=["STOCK", "HK_STOCK"],
    )

    calls = {"n": 0}

    async def _fake_https_raw(self, itf, params, codes):
        calls["n"] += 1
        # 两类别行同端点一次返回，由 infer_security_type 逐行归类
        return [
            {"code": "600000", "name": "浦发银行"},
            {"code": "hk00700", "name": "腾讯控股"},
        ]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_https_raw", _fake_https_raw)
    result = await MarketDataSyncService(session).sync_all_security_masters()
    assert result["failed"] == 0
    # 关键断言：同端点整轮只请求一次（多选冗余消除）
    assert calls["n"] == 1
    # 两类别行均被正确归类（infer_security_type 逐行推断，与组合持仓 type 同源）
    rows = (await session.execute(select(Security))).scalars().all()
    by_code = {r.code: r.asset_class for r in rows}
    assert by_code.get("sh600000") == SecurityType.STOCK
    assert by_code.get("hk00700") == SecurityType.HK_STOCK
    # used 跨批次去重后仍只含该接口一次
    assert result["used"] is not None and len(result["used"]) == 1


async def test_sync_skips_disabled_provider_master_interfaces(client, monkeypatch, session):
    """主数据同步须尊重提供方 enabled：停用提供方（如「小熊同学」）的接口不被采用。

    两提供方各挂一个 MASTER_LIST + STOCK 接口；停用方的接口即使能返回数据也不应被选中。
    修复前只过滤 QuoteInterface.enabled，停用提供方但其接口仍 enabled 时会被照用。
    """
    token = await _admin_token(client, "sm_admin_off_master@example.com")
    pid_on = await _create_provider(client, token, name="启用提供方")
    # 停用提供方（模拟「小熊同学」已停用）
    off_body = dict(PROVIDER_BODY, name="小熊同学", enabled=False)
    r = await client.post("/api/admin/quote-providers", json=off_body, headers=auth(token))
    status, code, data, _ = env(r)
    assert status == 200 and code == 0, data
    pid_off = data["id"]
    await _seed_fixed_categories(session)
    cid = MASTER_LIST_CAT_ID
    iid_on = await _create_interface(
        client, token, pid_on, cid,
        name="启用方主数据", asset_class=["STOCK"],
    )
    iid_off = await _create_interface(
        client, token, pid_off, cid,
        name="小熊同学主数据", asset_class=["STOCK"],
    )

    async def _fake_https_raw(self, itf, params, codes):
        # 两个接口都返回数据，验证「停用方即使有响应也不被采用」
        if itf.id == iid_off:
            return [{"code": "00700", "name": "腾讯控股"}]
        return [{"code": "600000", "name": "浦发银行"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_https_raw", _fake_https_raw)
    result = await MarketDataSyncService(session).sync_security_masters(
        SecurityType.STOCK
    )
    assert result["synced"] == 1  # 仅启用方接口被 upsert
    assert result["failed"] == 0
    used = result["used"]
    assert used is not None
    assert used["interfaceId"] == iid_on
    assert used["providerId"] == pid_on
    assert used["interfaceId"] != iid_off
    # 主数据里只应有启用方同步来的代码（带交易所前缀）
    rows = (await session.execute(select(Security))).scalars().all()
    assert {r.code for r in rows} == {"sh600000"}


async def test_fallback_fetch_skips_disabled_provider(client, monkeypatch, session):
    """fallback_fetch 同样须尊重提供方 enabled：停用提供方的 QUOTE 接口不参与解析。

    仅停用提供方（小熊同学）挂一个能返回价格的 QUOTE 接口，启用提供方无接口；
    同步该分类应拿不到数据（source=None），证明停用方接口被跳过。
    """
    token = await _admin_token(client, "sm_admin_off_fb@example.com")
    cid = await _create_category(client, token)
    off_body = dict(PROVIDER_BODY, name="小熊同学", enabled=False)
    r = await client.post("/api/admin/quote-providers", json=off_body, headers=auth(token))
    status, code, data, _ = env(r)
    assert status == 200 and code == 0, data
    pid_off = data["id"]
    await _create_interface(
        client, token, pid_off, cid,
        name="小熊同学行情", enabled=True,
    )

    async def _fake_https_raw(self, itf, params, codes):
        return [{"code": "600000", "price": "12.34"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_https_raw", _fake_https_raw)
    res = await MarketDataSyncService(session).fallback_fetch(cid, ["600000"])
    assert res.prices == {}  # 停用方接口被跳过 → 无数据
    assert res.source is None


# --------------------------------------------------------------------------- #
# 回归：主数据 code 规范为数字串 + 跨源去重（不同源带/不带交易所字母）
# --------------------------------------------------------------------------- #
async def test_sync_dedupes_master_code_across_formats(client, monkeypatch, session):
    """两源代码格式不一（"000001" vs "000001.SZ"）同步后主数据只保留一条且 code 带交易所前缀。

    回归：修复前按 (asset_class, code) 字符串匹配，两源 code 不同 → 各自追加 → 重复
    （如 2 个平安银行）。修复后 _upsert_masters 规范 code 为「交易所前缀 + 数字」，
    第二次同步命中已存在行并 UPDATE 而非插入新行。
    """
    token = await _admin_token(client, "sm_dedup_1@example.com")
    pid = await _create_provider(client, token)
    await _seed_fixed_categories(session)
    cid = MASTER_LIST_CAT_ID
    await _create_interface(
        client, token, pid, cid,
        name="主数据接口", asset_class=["STOCK"],
    )

    # 第一次同步：源返回无后缀代码（数字启发式推断 SZ → sz000001）
    async def _fake_v1(self, itf, params, codes):
        return [{"code": "000001", "name": "平安银行"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_https_raw", _fake_v1)
    res1 = await MarketDataSyncService(session).sync_all_security_masters()
    assert res1["synced"] == 1

    # 第二次同步：另一源返回带交易所后缀的代码（模拟「2 个不同源」）
    async def _fake_v2(self, itf, params, codes):
        return [{"code": "000001.SZ", "name": "平安银行"}]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_https_raw", _fake_v2)
    res2 = await MarketDataSyncService(session).sync_all_security_masters()
    assert res2["synced"] == 1  # 命中已存在 → UPDATE，仍计 1 条
    assert res2["deduped"] == 0  # 本次无存量重复可合并（写入已去重）

    # 主数据只应有一条，且 code 为「交易所前缀 + 数字」
    rows = (await session.execute(select(Security))).scalars().all()
    assert len(rows) == 1
    assert rows[0].code == "sz000001"
    assert rows[0].name == "平安银行"
    assert rows[0].exchange == "SZ"  # 由原始 000001.SZ 后缀推断


async def test_dedupe_masters_merges_existing_duplicate_rows(client, session):
    """sync_all 末尾自愈：存量重复主数据（"000001" 与 "000001.SZ" 同 asset_class）合并为一条。

    模拟「现在有 2 个平安银行」的历史脏数据，验证下次同步自动合并、保留最新更新行、
    且不误删被引用持仓（引用安全转移到保留行）。
    """
    token = await _admin_token(client, "sm_dedup_2@example.com")

    # 直接种入两条重复主数据（不同 code 字符串但同资产类别，规范后应都变成 sz000001）
    async with dbmod.AsyncSessionLocal() as s:
        old = Security(
            asset_class=SecurityType.STOCK, code="000001", name="平安银行",
            exchange="SZ", pinyin_initials="payh",
        )
        new = Security(
            asset_class=SecurityType.STOCK, code="000001.SZ", name="平安银行",
            exchange="SZ", pinyin_initials="payh",
        )
        s.add(old)
        s.add(new)
        await s.flush()
        # 给旧行挂一个组合持仓，验证合并时引用安全转移（不丢持仓）
        user = User(id=str(uuid.uuid4()), email="sm_dedup_hold@example.com",
                    password_hash="x", role="user")
        s.add(user)
        await s.flush()
        pf = Portfolio(id=str(uuid.uuid4()), user_id=user.id, name="P")
        s.add(pf)
        await s.flush()
        s.add(PortfolioSecurity(
            id=str(uuid.uuid4()), portfolio_id=pf.id, master_id=old.id,
            type=SecurityType.STOCK,
        ))
        # 给新行挂一个同组合持仓（keep 已持有 → 属重复，合并时应被丢弃）
        s.add(PortfolioSecurity(
            id=str(uuid.uuid4()), portfolio_id=pf.id, master_id=new.id,
            type=SecurityType.STOCK,
        ))
        await s.commit()

    # 触发自愈（无需 MASTER_LIST 接口，sync_all 仍会跑 _normalize_and_dedupe_masters）
    result = await MarketDataSyncService(session).sync_all_security_masters()
    assert result["synced"] == 0
    assert result["deduped"] == 1  # 合并掉 1 条重复

    # 只剩一条，code 为「交易所前缀 + 数字」
    rows = (await session.execute(select(Security))).scalars().all()
    assert len(rows) == 1
    assert rows[0].code == "sz000001"

    # 组合持仓引用被安全转移/合并：该组合只剩 1 条持仓，且指向保留行
    holdings = (
        await session.execute(select(PortfolioSecurity))
    ).scalars().all()
    assert len(holdings) == 1
    assert holdings[0].master_id == rows[0].id


async def test_infer_exchange_rules():
    """_infer_exchange 数字码交易所推断规则（§11.4 修复点）。"""
    # 显式前缀
    assert _infer_exchange("sh600000") == "SH"
    assert _infer_exchange("sz000001") == "SZ"
    assert _infer_exchange("bj920021") == "BJ"
    assert _infer_exchange("hk00700") == "HK"
    # 北交所主板 920xxx（须特判于 9→SH 之前）
    assert _infer_exchange("920000") == "BJ"
    # 港股 5 位码（须先于 SH/SZ/BJ 数字规则，修正 80016/02318 误归 BJ/SZ）
    assert _infer_exchange("80016") == "HK"
    assert _infer_exchange("02318") == "HK"
    assert _infer_exchange("00700") == "HK"
    # 1xxxxx：沪可转债 / 深可转债 / 深市基金（修正可转债漏前缀）
    assert _infer_exchange("110002") == "SH"
    assert _infer_exchange("120002") == "SZ"
    assert _infer_exchange("150001") == "SZ"
    assert _infer_exchange("160001") == "SZ"
    # 主线 A股 / 沪市基金
    assert _infer_exchange("600000") == "SH"
    assert _infer_exchange("000001") == "SZ"
    assert _infer_exchange("300001") == "SZ"
    assert _infer_exchange("500001") == "SH"


async def test_normalize_and_dedupe_reclassifies_corrupt_masters(session):
    """sync_all 末尾自愈：从数字码重推，修正存量错标行并合并重复。

    覆盖：北京 920xxx 误归 SH、港股 5 位码误归 BJ/SZ、可转债漏交易所前缀、
    以及同一证券因错标产生 sh/sz 双前缀重复。
    """
    # 北京 920xxx 被旧逻辑误存为 SH
    session.add(Security(asset_class=SecurityType.STOCK, code="sh920000", name="安徽凤凰", exchange="SH"))
    # 港股 5 位码 80016 被旧 head 规则误存为 BJ
    session.add(Security(asset_class=SecurityType.HK_STOCK, code="bj80016", name="新鸿基地产－Ｒ", exchange="BJ"))
    # 港股 02318 被误存为 SZ
    session.add(Security(asset_class=SecurityType.HK_STOCK, code="sz02318", name="中国平安", exchange="SZ"))
    # 可转债 110002 漏交易所前缀（exchange=NULL）
    session.add(Security(asset_class=SecurityType.CONVERTIBLE_BOND, code="110002", name="南山转债", exchange=None))
    # 重复：同一北京 920000 另一源误存为 SZ（应合并进 bj920000）
    session.add(Security(asset_class=SecurityType.STOCK, code="sz920000", name="安徽凤凰", exchange="SZ"))
    await session.flush()

    # 直接调用自愈（无需 MASTER_LIST 接口）
    removed = await MarketDataSyncService(session)._normalize_and_dedupe_masters()
    # sh920000 / sz920000 重分类后都变成 bj920000 → 合并掉 1 条
    assert removed == 1

    rows = (await session.execute(select(Security))).scalars().all()
    by_code = {r.code: r for r in rows}
    # 北京 920xxx → BJ（重复已合并）
    assert "bj920000" in by_code
    assert by_code["bj920000"].exchange == "BJ"
    assert by_code["bj920000"].asset_class == SecurityType.STOCK
    # 港股 5 位码 → HK
    assert "hk80016" in by_code and by_code["hk80016"].exchange == "HK"
    assert by_code["hk80016"].asset_class == SecurityType.HK_STOCK
    assert "hk02318" in by_code and by_code["hk02318"].exchange == "HK"
    assert by_code["hk02318"].asset_class == SecurityType.HK_STOCK
    # 可转债 → 补 SH 前缀
    assert "sh110002" in by_code and by_code["sh110002"].exchange == "SH"
    assert by_code["sh110002"].asset_class == SecurityType.CONVERTIBLE_BOND


async def test_dedupe_masters_drops_old_third_board_and_rejected_cb(session):
    """老三板/全国股转(4xxxxx) 与北交所旧段(8xxxxx) 在自愈时被物理删除，不写入主数据表。

    覆盖：
    - 名称含「退债」的退市可转债（落 4xxxxx 段，如 bj404001 航信退债）同样丢弃，不作例外；
    - 深交所可转债（123999 X退债）不在丢弃段，按代码前缀正确归为可转债；
    - 普通可转债（110002 南山转债）不受影响，仍归可转债。
    """
    # 退市可转债（名称含「退债」，代码 4xxxxx 段）：应被丢弃，不入库
    session.add(Security(asset_class=SecurityType.BOND, code="bj404001", name="航信退债", exchange="BJ"))
    # 深交所可转债（123999 不在丢弃段）：应保留为可转债
    session.add(
        Security(asset_class=SecurityType.CONVERTIBLE_BOND, code="sz123999", name="X退债", exchange="SZ")
    )
    # 普通可转债（不应受影响，仍归可转债）
    session.add(
        Security(asset_class=SecurityType.CONVERTIBLE_BOND, code="110002", name="南山转债", exchange=None)
    )
    await session.flush()

    await MarketDataSyncService(session)._normalize_and_dedupe_masters()

    rows = (await session.execute(select(Security))).scalars().all()
    by_name = {r.name: r for r in rows}
    # 退债落 4xxxxx 段 → 丢弃，不在表中
    assert "航信退债" not in by_name
    # 可转债（123999/110002）→ 保留且正确归类
    assert by_name["X退债"].asset_class == SecurityType.CONVERTIBLE_BOND
    assert by_name["南山转债"].asset_class == SecurityType.CONVERTIBLE_BOND


async def test_list_security_masters_uncategorized_matches_value(client, session):
    """未分类筛选：主数据行 asset_class 为显式值 'UNCATEGORIZED'（非 NULL）也应命中。"""
    token = await _admin_token(client, "sm_uncat_val@example.com")
    async with dbmod.AsyncSessionLocal() as s:
        s.add(Security(asset_class=SecurityType.UNCATEGORIZED, code="sh123456", name="某未分类证券", exchange="SH"))
        s.add(Security(asset_class=SecurityType.STOCK, code="sh600000", name="平安银行", exchange="SH"))
        await s.commit()
    r = await client.get(
        "/api/admin/securities/masters?asset_class=UNCATEGORIZED", headers=auth(token)
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    codes = [i["code"] for i in data["items"]]
    assert "sh123456" in codes
    assert "sh600000" not in codes


# --------------------------------------------------------------------------- #
# DELETE /api/admin/securities/masters：批量/单行删除（拦截被组合持仓引用的主数据）
# --------------------------------------------------------------------------- #
async def _delete_masters(client, token, ids):
    """调用 DELETE 删除主数据，返回原始 httpx 响应。

    注意：httpx 的 delete() 便捷方法不接受 content/json 参数，须走 request()。
    """
    return await client.request(
        "DELETE",
        "/api/admin/securities/masters",
        json={"ids": ids},
        headers=auth(token),
    )


async def _seed_user_portfolio_and_holding(session, email: str, master_id: str):
    """建普通用户 + 组合 + 一条引用该主数据的组合持仓（用于引用拦截验证）。"""
    user = User(id=str(uuid.uuid4()), email=email, password_hash="x", role="user")
    session.add(user)
    await session.flush()
    pf = Portfolio(id=str(uuid.uuid4()), user_id=user.id, name="P")
    session.add(pf)
    await session.flush()
    holding = PortfolioSecurity(
        id=str(uuid.uuid4()),
        portfolio_id=pf.id,
        master_id=master_id,
        type=SecurityType.STOCK,
    )
    session.add(holding)
    await session.commit()
    return user, pf, holding


async def test_delete_security_master_intercepted_when_referenced(client, session):
    """被组合持仓引用的主数据禁止删除：计入 skipped，原行保留。"""
    token = await _admin_token(client, "del_ref_admin@example.com")
    master = await _seed_master(
        session, "sh600000", "浦发银行", SecurityType.STOCK, "pfyh", "SH"
    )
    await _seed_user_portfolio_and_holding(
        session, "del_ref_user@example.com", master.id
    )

    r = await _delete_masters(client, token, [master.id])
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["deleted"] == 0
    assert len(data["skipped"]) == 1
    assert data["skipped"][0]["id"] == master.id
    assert "引用" in data["skipped"][0]["reason"]

    # 引用拦截下原行仍存在
    remaining = (
        await session.execute(select(Security).where(Security.id == master.id))
    ).scalars().all()
    assert len(remaining) == 1


async def test_delete_security_master_orphans(client, session):
    """删除孤儿主数据：两条均成功删除，表中对应行消失。"""
    token = await _admin_token(client, "del_orphan_admin@example.com")
    m1 = await _seed_master(session, "sh600000", "浦发银行", SecurityType.STOCK, "pfyh", "SH")
    m2 = await _seed_master(session, "sz000001", "平安银行", SecurityType.STOCK, "payh", "SZ")

    r = await _delete_masters(client, token, [m1.id, m2.id])
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["deleted"] == 2
    assert data["skipped"] == []

    # 表中对应行已消失
    remaining = (await session.execute(select(Security))).scalars().all()
    assert {r2.id for r2 in remaining} == set()


async def test_delete_security_master_batch_mixed(client, session):
    """批量混合：1 孤儿 + 1 被引用 + 1 不存在 id → 删 1，skipped 恰含被引用与不存在两项。"""
    token = await _admin_token(client, "del_mix_admin@example.com")
    orphan = await _seed_master(session, "sh600000", "浦发银行", SecurityType.STOCK, "pfyh", "SH")
    referenced = await _seed_master(session, "sz000001", "平安银行", SecurityType.STOCK, "payh", "SZ")
    await _seed_user_portfolio_and_holding(
        session, "del_mix_user@example.com", referenced.id
    )
    nonexistent = str(uuid.uuid4())

    r = await _delete_masters(client, token, [orphan.id, referenced.id, nonexistent])
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["deleted"] == 1
    assert {s["id"] for s in data["skipped"]} == {referenced.id, nonexistent}
    reasons = {s["id"]: s["reason"] for s in data["skipped"]}
    assert "引用" in reasons[referenced.id]
    assert reasons[nonexistent] == "主数据不存在"

    # 孤儿被删、被引用与不存在的未受影响
    remaining = (
        await session.execute(
            select(Security).where(Security.id.in_([orphan.id, referenced.id]))
        )
    ).scalars().all()
    assert {r2.id for r2 in remaining} == {referenced.id}


async def test_delete_security_master_dedup_duplicate_ids(client, session):
    """边界：重复 id 去重只删一次，表中无残留。"""
    token = await _admin_token(client, "del_dup_admin@example.com")
    m = await _seed_master(session, "sh600000", "浦发银行", SecurityType.STOCK, "pfyh", "SH")

    r = await _delete_masters(client, token, [m.id, m.id, m.id])
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["deleted"] == 1

    remaining = (await session.execute(select(Security))).scalars().all()
    assert len(remaining) == 0


async def test_delete_security_master_empty_ids_returns_400(client, session):
    """边界：空 ids [] → 400。"""
    token = await _admin_token(client, "del_empty_admin@example.com")
    r = await _delete_masters(client, token, [])
    assert r.status_code == 400


async def test_delete_security_master_requires_admin(client, session):
    """权限：非管理员（普通登录用户）删除主数据 → 403。"""
    creds = await register_login(client, email="del_user_1@example.com", password="pw123456")
    r = await _delete_masters(client, creds["token"], [str(uuid.uuid4())])
    assert r.status_code == 403


async def test_delete_security_master_stats_and_list_updated(client, session):
    """回归：删除后类别计数减少、列表 total 减少。"""
    token = await _admin_token(client, "del_reg_admin@example.com")
    await _seed_master(session, "sh600000", "浦发银行", SecurityType.STOCK, "pfyh", "SH")
    m2 = await _seed_master(session, "sz000001", "平安银行", SecurityType.STOCK, "payh", "SZ")

    # 删前断言有 2 条 STOCK
    r = await client.get("/api/admin/securities/masters/stats", headers=auth(token))
    _, _, data, _ = env(r)
    assert data["counts"].get("STOCK") == 2

    r = await _delete_masters(client, token, [m2.id])
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["deleted"] == 1

    # stats 计数减少
    r = await client.get("/api/admin/securities/masters/stats", headers=auth(token))
    _, _, data, _ = env(r)
    assert data["counts"].get("STOCK") == 1

    # 列表 total 减少
    r = await client.get("/api/admin/securities/masters", headers=auth(token))
    _, _, data, _ = env(r)
    assert data["total"] == 1


async def test_delete_security_master_all_deletes_orphans_only(client, session):
    """all=True：删除「当前筛选条件下全部孤儿主数据」，被引用的转入 skipped。"""
    token = await _admin_token(client, "del_all_admin@example.com")
    o1 = await _seed_master(session, "sh600000", "浦发银行", SecurityType.STOCK, "pfyh", "SH")
    o2 = await _seed_master(session, "sz000001", "平安银行", SecurityType.STOCK, "payh", "SZ")
    o3 = await _seed_master(session, "hk00700", "腾讯控股", SecurityType.HK_STOCK, "txkh", "HK")
    referenced = await _seed_master(session, "bj600519", "贵州茅台", SecurityType.STOCK, "gzmz", "SH")
    await _seed_user_portfolio_and_holding(session, "del_all_user@example.com", referenced.id)

    r = await client.request(
        "DELETE",
        "/api/admin/securities/masters",
        json={"all": True},
        headers=auth(token),
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["deleted"] == 3  # 三个孤儿
    assert len(data["skipped"]) == 1
    assert data["skipped"][0]["id"] == referenced.id
    assert "引用" in data["skipped"][0]["reason"]

    # 被引用的原行保留
    remaining = (
        await session.execute(select(Security).where(Security.id == referenced.id))
    ).scalars().all()
    assert len(remaining) == 1


async def test_delete_security_master_all_respects_filter(client, session):
    """all=True 配合 asset_class 筛选：仅删除该类别孤儿，其余类别不受影响。"""
    token = await _admin_token(client, "del_all_flt_admin@example.com")
    stock1 = await _seed_master(session, "sh600000", "浦发银行", SecurityType.STOCK, "pfyh", "SH")
    stock2 = await _seed_master(session, "sz000001", "平安银行", SecurityType.STOCK, "payh", "SZ")
    hk = await _seed_master(session, "hk00700", "腾讯控股", SecurityType.HK_STOCK, "txkh", "HK")

    r = await client.request(
        "DELETE",
        "/api/admin/securities/masters",
        json={"all": True, "asset_class": "STOCK"},
        headers=auth(token),
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["deleted"] == 2  # 仅 STOCK 孤儿
    assert data["skipped"] == []

    # HK_STOCK 不受影响
    remaining = (
        await session.execute(select(Security).where(Security.id == hk.id))
    ).scalars().all()
    assert len(remaining) == 1
    # STOCK 已删
    gone = (
        await session.execute(select(Security).where(Security.id.in_([stock1.id, stock2.id])))
    ).scalars().all()
    assert gone == []


# --------------------------------------------------------------------------- #
# 证券主数据 id 确定性派生（业务键 (asset_class, code) → 稳定 uuid5）
# --------------------------------------------------------------------------- #
class _FakeMasterInterface:
    """最小接口桩：仅需 _upsert_masters 读取的字段。"""

    resp_code_field = "code"
    resp_name_field = "name"
    resp_exchange_field = None


async def test_master_id_for_is_deterministic(session):
    """master_id_for：同 (asset_class, code) 多次调用返回同一 36 字符 UUID；不同 key 不同；输出合法 UUID。"""
    a = master_id_for(SecurityType.STOCK, "sh600000")
    b = master_id_for(SecurityType.STOCK, "sh600000")
    assert a == b
    assert len(a) == 36
    # 合法 UUID
    assert uuid.UUID(a) is not None

    # 不同 code → 不同 id
    assert master_id_for(SecurityType.STOCK, "sz000001") != a
    # 不同 asset_class（同 code）→ 不同 id
    assert master_id_for(SecurityType.HK_STOCK, "sh600000") != a
    # asset_class=None 哨兵分支也确定性且独立于 STOCK
    null_id = master_id_for(None, "sh600000")
    assert null_id != a
    assert len(null_id) == 36 and uuid.UUID(null_id) is not None


async def test_upsert_masters_assigns_deterministic_id_and_survives_delete_rebuild(
    session,
):
    """_upsert_masters 新插入行用确定性 id；删除该主数据后再次同步同 (ac, code) 得同一 id。"""
    svc = MarketDataSyncService(session)
    n = await svc._upsert_masters(
        _FakeMasterInterface(), [{"code": "600000", "name": "浦发银行"}]
    )
    assert n == 1
    row = (
        await session.execute(
            select(Security).where(
                Security.asset_class == SecurityType.STOCK,
                Security.code == "sh600000",
            )
        )
    ).scalar_one()
    id1 = row.id
    assert id1 == master_id_for(SecurityType.STOCK, "sh600000")

    # 模拟「删除后重新同步」：直接 DELETE 该行并提交
    await session.delete(row)
    await session.commit()

    # 再次同步同 (ac, code)
    svc2 = MarketDataSyncService(session)
    n2 = await svc2._upsert_masters(
        _FakeMasterInterface(), [{"code": "600000", "name": "浦发银行"}]
    )
    assert n2 == 1
    row2 = (
        await session.execute(
            select(Security).where(
                Security.asset_class == SecurityType.STOCK,
                Security.code == "sh600000",
            )
        )
    ).scalar_one()
    id2 = row2.id
    assert id2 == id1  # 删除重建保持同一 id
    assert id2 == master_id_for(SecurityType.STOCK, "sh600000")


async def test_conflict_merge_keeps_canonical_id_stable(session):
    """冲突合并（含 asset_class=NULL 分支）后，同一 (ac, code) 的确定性 id 始终可由 master_id_for 复现。

    注：合并保留行的 id 为历史值（随机），但 (ac, code) 这一业务键唯一确定其确定性 id；
    删除该保留行并重新同步即重建为 master_id_for(ac, code)，保证外键引用稳定可重建。
    """
    # 两条重复 STOCK+sh600000（不同 code 字符串，重规范后同 (STOCK, sh600000)）
    s1 = Security(
        asset_class=SecurityType.STOCK, code="600000", name="浦发银行",
        exchange="SH", pinyin_initials="pfyh",
    )
    s2 = Security(
        asset_class=SecurityType.STOCK, code="600000.SZ", name="浦发银行",
        exchange="SZ", pinyin_initials="pfyh",
    )
    # asset_class=NULL 分支：原存 NULL，重推断归 STOCK → 同样并入 (STOCK, sh600000)
    s3 = Security(
        asset_class=None, code="600000", name="浦发银行",
        exchange="SH", pinyin_initials="pfyh",
    )
    session.add_all([s1, s2, s3])
    await session.flush()

    removed = await MarketDataSyncService(session)._normalize_and_dedupe_masters()
    assert removed == 2  # 合并掉 2 条重复

    rows = (await session.execute(select(Security))).scalars().all()
    assert len(rows) == 1
    kept = rows[0]
    assert kept.code == "sh600000"
    assert kept.asset_class == SecurityType.STOCK

    # 该 (ac, code) 的确定性 id 唯一确定；删除→重建得同一 id
    expected = master_id_for(SecurityType.STOCK, "sh600000")
    await session.delete(kept)
    await session.commit()
    svc = MarketDataSyncService(session)
    await svc._upsert_masters(
        _FakeMasterInterface(), [{"code": "600000", "name": "浦发银行"}]
    )
    rebuilt = (
        await session.execute(
            select(Security).where(Security.code == "sh600000")
        )
    ).scalar_one()
    assert rebuilt.id == expected


async def test_rebuild_keeps_foreign_key_intact(session):
    """重建后 portfolio_securities.master_id 均指向存在的 securities.id（无孤儿）。

    设计说明：securities.id 经确定性派生后，被引用主数据删除会随 ondelete=CASCADE 级联删除
    其组合持仓（删除端点对此拦截，本系统既有设计）；无引用的孤儿主数据删除后重新同步可得
    同一确定性 id。本用例验证：(1) 既有持仓外键全部成立（无孤儿）；(2) 删除一个孤儿主数据并
    重建后，另一组合持仓仍指向存在的 securities.id（无孤儿遗留）。
    """
    svc = MarketDataSyncService(session)
    await svc._upsert_masters(
        _FakeMasterInterface(),
        [{"code": "600000", "name": "浦发银行"}, {"code": "000001", "name": "平安银行"}],
    )
    masters = {
        r.code: r
        for r in (await session.execute(select(Security))).scalars().all()
    }
    m1 = masters["sh600000"]
    m2 = masters["sz000001"]

    # 两个组合各持有一项（互相独立）
    u1 = User(id=str(uuid.uuid4()), email="det_fk_u1@example.com",
              password_hash="x", role="user")
    session.add(u1)
    await session.flush()
    pf1 = Portfolio(id=str(uuid.uuid4()), user_id=u1.id, name="P1")
    session.add(pf1)
    await session.flush()
    session.add(PortfolioSecurity(
        id=str(uuid.uuid4()), portfolio_id=pf1.id, master_id=m1.id,
        type=SecurityType.STOCK,
    ))

    u2 = User(id=str(uuid.uuid4()), email="det_fk_u2@example.com",
              password_hash="x", role="user")
    session.add(u2)
    await session.flush()
    pf2 = Portfolio(id=str(uuid.uuid4()), user_id=u2.id, name="P2")
    session.add(pf2)
    await session.flush()
    session.add(PortfolioSecurity(
        id=str(uuid.uuid4()), portfolio_id=pf2.id, master_id=m2.id,
        type=SecurityType.STOCK,
    ))
    await session.commit()

    # FK 全部成立：每条持仓都指向存在的 securities.id（无孤儿）
    holdings = (await session.execute(select(PortfolioSecurity))).scalars().all()
    assert len(holdings) == 2
    for ps in holdings:
        exists = (
            await session.execute(
                select(Security.id).where(Security.id == ps.master_id)
            )
        ).scalar_one_or_none()
        assert exists is not None

    # 删除 m1（其持仓随 ondelete=CASCADE 级联删除），重建 m1
    await session.delete(m1)
    await session.commit()
    svc2 = MarketDataSyncService(session)
    await svc2._upsert_masters(
        _FakeMasterInterface(), [{"code": "600000", "name": "浦发银行"}]
    )
    new_m1 = (
        await session.execute(
            select(Security).where(Security.code == "sh600000")
        )
    ).scalar_one()
    assert new_m1.id == master_id_for(SecurityType.STOCK, "sh600000")

    # m2 的持仓仍指向存在的 securities；无孤儿残留
    remaining = (await session.execute(select(PortfolioSecurity))).scalars().all()
    assert len(remaining) == 1
    assert remaining[0].master_id == m2.id
    assert (
        await session.execute(
            select(Security.id).where(Security.id == remaining[0].master_id)
        )
    ).scalar_one_or_none() is not None


async def test_migration_invariant_all_securities_id_is_deterministic(session):
    """迁移不变量（验证用）：经 conftest 对测试库 alembic upgrade head 后，所有 securities
    行 id == master_id_for(asset_class, code)，且 portfolio_securities 无孤儿。"""
    rows = (await session.execute(select(Security))).scalars().all()
    for r in rows:
        assert r.id == master_id_for(r.asset_class, r.code), (
            f"securities.id 未对齐确定性派生: {r.id} vs {master_id_for(r.asset_class, r.code)}"
        )

    # 无孤儿外键
    orphan = (
        await session.execute(
            select(PortfolioSecurity.id).join(
                Security, PortfolioSecurity.master_id == Security.id, isouter=True
            ).where(Security.id.is_(None))
        )
    ).scalars().all()
    assert orphan == []
