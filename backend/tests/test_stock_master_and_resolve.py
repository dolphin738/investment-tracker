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
from app.models import Portfolio, Security, User
from app.models.enums import InterfacePurpose, SecurityType
from app.services.market_data_sync import MarketDataSyncService

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


async def _seed_master(session, code, name, typ, pinyin, exchange=None):
    sec = Security(
        portfolio_id=None,
        asset_class=typ,
        code=code,
        name=name,
        type=typ,
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
    await _seed_master(session, "600000", "浦发银行", SecurityType.STOCK, "pfyh", "SH")
    await _seed_master(session, "000001", "平安银行", SecurityType.STOCK, "payh", "SZ")
    await _seed_master(session, "00700", "腾讯控股", SecurityType.HK_STOCK, "txkg", "HK")

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
        "id", "code", "name", "exchange", "type", "updatedAt",
    }

    # q 匹配 code
    r = await client.get("/api/admin/securities/masters?q=600000", headers=auth(token))
    _, _, data, _ = env(r)
    assert data["total"] == 1 and data["items"][0]["code"] == "600000"

    # q 匹配 name（中文）
    r = await client.get("/api/admin/securities/masters?q=平安", headers=auth(token))
    _, _, data, _ = env(r)
    assert data["total"] == 1 and data["items"][0]["code"] == "000001"

    # q 匹配拼音首字母
    r = await client.get("/api/admin/securities/masters?q=pfyh", headers=auth(token))
    _, _, data, _ = env(r)
    assert data["total"] == 1 and data["items"][0]["code"] == "600000"


async def test_list_security_masters_excludes_portfolio_rows(client, session):
    """主数据端点只返回 portfolio_id IS NULL 行，组合维度持仓行不出现。"""
    token = await _admin_token(client, "sm_admin_2@example.com")
    # 主数据行
    await _seed_master(session, "600000", "浦发银行", SecurityType.STOCK, "pfyh", "SH")
    # 组合行（portfolio_id 非空）：直接造一个 user+portfolio
    user = User(id=str(uuid.uuid4()), email="sm_pf@example.com", password_hash="x", role="user")
    session.add(user)
    await session.flush()
    pf = Portfolio(id=str(uuid.uuid4()), user_id=user.id, name="P")
    session.add(pf)
    await session.flush()
    session.add(
        Security(
            portfolio_id=pf.id, code="600000", name="浦发银行（组合）",
            type=SecurityType.STOCK,
        )
    )
    await session.commit()

    r = await client.get("/api/admin/securities/masters", headers=auth(token))
    _, _, data, _ = env(r)
    assert data["total"] == 1
    assert data["items"][0]["code"] == "600000"
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
    assert data["parsed"] == {"600000": "12.34", "000001": "9.87"}
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
    sec = Security(
        id=str(uuid.uuid4()), portfolio_id=pf.id, code="600000",
        name="浦发银行", type=SecurityType.STOCK, exchange="SH",
    )
    session.add(sec)
    await session.commit()
    token = create_access_token(user.id, user.email, "user")

    r = await client.post(
        f"/api/portfolios/{pf.id}/securities/resolve",
        json={"code": "600000", "name": "浦发银行"},
        headers=auth(token),
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["id"] == sec.id  # 命中已有组合行，返回同一 id
    assert data["isNew"] is False
    assert data["code"] == "600000"
    assert data["type"] == "STOCK"
    assert data["exchange"] == "SH"


async def test_resolve_creates_from_master_row(client, session):
    user, pf = await _user_and_portfolio(session, "res2@example.com")
    master = Security(
        id=str(uuid.uuid4()), portfolio_id=None, asset_class=SecurityType.STOCK,
        code="600519", name="贵州茅台", type=SecurityType.STOCK, exchange="SH",
        pinyin_initials="gzm",
    )
    session.add(master)
    await session.commit()
    token = create_access_token(user.id, user.email, "user")

    r = await client.post(
        f"/api/portfolios/{pf.id}/securities/resolve",
        json={"code": "600519"},
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
    """主数据无该 code 时，按请求体兜底新建组合行。"""
    user, pf = await _user_and_portfolio(session, "res3@example.com")
    token = create_access_token(user.id, user.email, "user")

    r = await client.post(
        f"/api/portfolios/{pf.id}/securities/resolve",
        json={"code": "600999", "name": "新标的", "type": "ETF", "exchange": "SH"},
        headers=auth(token),
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["isNew"] is True
    assert data["code"] == "600999"
    assert data["name"] == "新标的"
    assert data["type"] == "ETF"
    assert data["exchange"] == "SH"


async def test_resolve_not_found_for_other_user_portfolio(client, session):
    """组合归属隔离：resolve 他人组合 → 404（不泄露存在性）。"""
    user, pf = await _user_and_portfolio(session, "res4@example.com")
    other = User(id=str(uuid.uuid4()), email="res4b@example.com", password_hash="x", role="user")
    session.add(other)
    await session.commit()
    token = create_access_token(other.id, other.email, "user")
    r = await client.post(
        f"/api/portfolios/{pf.id}/securities/resolve",
        json={"code": "600000"},
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
    cid = await _create_category(client, token)
    # §11 配置能力：create schema 现已透传 purpose/asset_class，经 API 直接建 MASTER_LIST 接口
    iid = await _create_interface(
        client,
        token,
        pid,
        cid,
        name="A股主数据",
        purpose=InterfacePurpose.MASTER_LIST.value,
        asset_class=SecurityType.STOCK.value,
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
        await session.execute(select(Security).where(Security.portfolio_id.is_(None)))
    ).scalars().all()
    assert {r.code for r in rows} == {"600000", "000001"}


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
    assert data["parsed"] == {"600000": "12.34"}


async def test_quote_interface_create_update_master_list_fields(client):
    """§11 配置能力：接口 create/update 透传 purpose/asset_class/resp_name_field/resp_exchange_field。"""
    token = await _admin_token(client, "sm_admin_10@example.com")
    pid = await _create_provider(client, token)
    cid = await _create_category(client, token)

    # create：设 MASTER_LIST + HK_STOCK + 自定义解析字段
    iid = await _create_interface(
        client,
        token,
        pid,
        cid,
        name="港股主数据",
        purpose="MASTER_LIST",
        asset_class="HK_STOCK",
        resp_name_field="sec_name",
        resp_exchange_field="market",
    )
    r = await client.get(
        f"/api/admin/quote-providers/interfaces/{iid}", headers=auth(token)
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["purpose"] == "MASTER_LIST"
    assert data["asset_class"] == "HK_STOCK"
    assert data["resp_name_field"] == "sec_name"
    assert data["resp_exchange_field"] == "market"

    # update：显式改值生效；未提供的字段保持原值（service 约定 None=未提供）
    r = await client.patch(
        f"/api/admin/quote-providers/interfaces/{iid}",
        json={"purpose": "QUOTE", "resp_name_field": "name"},
        headers=auth(token),
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["purpose"] == "QUOTE"
    assert data["resp_name_field"] == "name"
    assert data["asset_class"] == "HK_STOCK"
    assert data["resp_exchange_field"] == "market"
