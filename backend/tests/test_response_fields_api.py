"""response_fields API 单测（步骤 1/2 后端）：契约端点 / 校验 400 / 双写折叠 / 试调命中率。

走真实 ASGI app + 测试库（conftest）；admin 以 DB 实时 role 为准。
"""
from __future__ import annotations

import pytest
from sqlalchemy import update

from app.models import InterfaceCategory, User
from tests.helpers import auth, env, register_login


async def _admin(session, client, email: str) -> dict:
    info = await register_login(client, email=email)
    await session.execute(update(User).where(User.email == email).values(role="admin"))
    await session.commit()
    return info


async def _provider(client, token: str) -> str:
    r = await client.post(
        "/api/admin/quote-providers",
        json={"name": "测试源", "access_method": "https",
              "config": {"base_url": "https://x.example.com"}},
        headers=auth(token),
    )
    assert r.status_code == 200, r.text
    return env(r)[2]["id"]


async def _display_category(client, token: str) -> str:
    r = await client.post(
        "/api/admin/interface-categories",
        json={"label": "自定义展示分类"},
        headers=auth(token),
    )
    assert r.status_code == 200, r.text
    return env(r)[2]["id"]


async def _create_iface(client, token: str, pid: str, **fields):
    body = {"category_id": fields.pop("category_id"), "name": fields.pop("name", "接口")}
    body.update(fields)
    return await client.post(
        f"/api/admin/quote-providers/{pid}/interfaces",
        json=body,
        headers=auth(token),
    )


async def _seed_quote_category(session) -> None:
    session.add(InterfaceCategory(id="2", label="证券行情", system=True))
    await session.commit()


# ───────────────────────── 契约端点 ─────────────────────────
@pytest.mark.asyncio
async def test_schema_endpoint_returns_contract(session, client):
    info = await _admin(session, client, "rf_schema@example.com")
    r = await client.get(
        "/api/admin/quote-interfaces/response-field-schema", headers=auth(info["token"])
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert {s["value"] for s in data["slots"]} == {"code", "name", "exchange", "price", "date"}
    assert set(data["contracts"]["2"]["required"]) == {"code", "price", "date"}
    assert set(data["contracts"]["1"]["required"]) == {"code"}
    assert "decimal" in data["types"]
    assert "yuan" in data["units"]


@pytest.mark.asyncio
async def test_schema_endpoint_requires_admin(session, client):
    info = await register_login(client, email="rf_nonadmin@example.com")
    r = await client.get(
        "/api/admin/quote-interfaces/response-field-schema", headers=auth(info["token"])
    )
    assert env(r)[0] == 403


# ───────────────────────── 校验 400 / 契约 ─────────────────────────
@pytest.mark.asyncio
async def test_create_rejects_invalid_slot(session, client):
    info = await _admin(session, client, "rf_bad_slot@example.com")
    pid = await _provider(client, info["token"])
    cid = await _display_category(client, info["token"])
    r = await _create_iface(
        client, info["token"], pid, category_id=cid,
        response_fields=[{"key": "x", "slot": "open", "source": "a"}],
    )
    assert env(r)[0] == 400


@pytest.mark.asyncio
async def test_create_rejects_contract_violation(session, client):
    """QUOTE 用途接口缺 date 槽 → 400（方案 §6 分类契约）。"""
    info = await _admin(session, client, "rf_contract@example.com")
    await _seed_quote_category(session)
    pid = await _provider(client, info["token"])
    r = await _create_iface(
        client, info["token"], pid, category_id="2",
        response_fields=[
            {"key": "code", "slot": "code", "source": "code"},
            {"key": "price", "slot": "price", "source": "price"},
        ],
    )
    status, code, _, message = env(r)
    assert status == 400 and code != 0
    assert "date" in (message or "")


@pytest.mark.asyncio
async def test_create_rejects_unicode_digit_index_source(session, client):
    """D2：source 含 Unicode 上标数字（isdigit 为 True 但 int 失败）→ 400 而非 500。"""
    info = await _admin(session, client, "rf_bad_idx@example.com")
    pid = await _provider(client, info["token"])
    cid = await _display_category(client, info["token"])
    r = await _create_iface(
        client, info["token"], pid, category_id=cid,
        response_fields=[{"key": "x", "source": "a[²]"}],
    )
    status, code, _, message = env(r)
    assert status == 400 and code != 0
    assert "下标" in (message or "")


@pytest.mark.asyncio
async def test_create_accepts_arabic_indic_digit_index_source(session, client):
    """D2 约束：阿拉伯-印度数字下标当前可工作，行为零变化。"""
    info = await _admin(session, client, "rf_arabic_idx@example.com")
    pid = await _provider(client, info["token"])
    cid = await _display_category(client, info["token"])
    r = await _create_iface(
        client, info["token"], pid, category_id=cid,
        response_fields=[{"key": "x", "source": "a[١]"}],
    )
    assert env(r)[0] == 200


@pytest.mark.asyncio
async def test_create_accepts_display_only_fields(session, client):
    """展示分类（无同步用途）不强制 slot；无 slot 条目不参与契约校验（§5.2）。"""
    info = await _admin(session, client, "rf_display@example.com")
    pid = await _provider(client, info["token"])
    cid = await _display_category(client, info["token"])
    r = await _create_iface(
        client, info["token"], pid, category_id=cid,
        response_fields=[{"key": "title", "label": "标题", "source": "公告标题"}],
    )
    assert env(r)[0] == 200


# ───────────────────────── 双写 / 折叠 ─────────────────────────
@pytest.mark.asyncio
async def test_create_with_response_fields_dual_writes_legacy(session, client):
    """显式 response_fields → 旧列镜像按槽派生（Expand 双写）。"""
    info = await _admin(session, client, "rf_dual@example.com")
    await _seed_quote_category(session)
    pid = await _provider(client, info["token"])
    r = await _create_iface(
        client, info["token"], pid, category_id="2",
        response_fields=[
            {"key": "code", "slot": "code", "source": "secu_code"},
            {"key": "price", "slot": "price", "source": "data.last"},
            {"key": "date", "slot": "date", "source": "trade_date"},
        ],
    )
    status, _, data, _ = env(r)
    assert status == 200
    assert data["resp_code_field"] == "secu_code"
    assert data["resp_price_field"] == "data.last"
    assert data["response_parse"]["resp_date_field"] == "trade_date"
    assert isinstance(data["response_fields"], list) and len(data["response_fields"]) == 3


@pytest.mark.asyncio
async def test_create_with_legacy_only_folds_response_fields(session, client):
    """老前端只给旧列 → 确定性折成 response_fields 落库。"""
    info = await _admin(session, client, "rf_fold@example.com")
    pid = await _provider(client, info["token"])
    cid = await _display_category(client, info["token"])
    r = await _create_iface(
        client, info["token"], pid, category_id=cid,
        resp_code_field="0", resp_name_field="1",
    )
    status, _, data, _ = env(r)
    assert status == 200
    folded = data["response_fields"]
    assert isinstance(folded, list)
    by_key = {f["key"]: f for f in folded}
    assert by_key["code"]["slot"] == "code" and by_key["code"]["source"] == "0"
    assert by_key["name"]["slot"] == "name" and by_key["name"]["source"] == "1"


# ───────────────────────── 试调逐槽位命中率（步骤 2） ─────────────────────────
@pytest.mark.asyncio
async def test_test_endpoint_reports_field_hits(session, client, monkeypatch):
    info = await _admin(session, client, "rf_test@example.com")
    pid = await _provider(client, info["token"])
    cid = await _display_category(client, info["token"])
    r = await _create_iface(client, info["token"], pid, category_id=cid, name="行情接口")
    iid = env(r)[2]["id"]

    from app.services.market_data_sync import MarketDataSyncService

    async def _fake_https_raw(self, itf, params, codes):
        return [
            {"code": "600000", "price": "12.34"},
            {"code": "000001"},  # price 缺失
        ]

    monkeypatch.setattr(MarketDataSyncService, "_fetch_https_raw", _fake_https_raw)
    resp = await client.post(
        f"/api/admin/quote-interfaces/{iid}/test",
        json={"params": {"a": "b"}},
        headers=auth(info["token"]),
    )
    status, _, data, _ = env(resp)
    assert status == 200 and data["ok"] is True
    # 逐槽位命中率
    hits = {h["slot"]: h for h in data["fieldHits"]}
    assert hits["code"]["hit"] == 2 and hits["code"]["missing"] == 0
    assert hits["price"]["hit"] == 1 and hits["price"]["missing"] == 1
    assert hits["price"]["sample"] == "12.34"
    assert data["rowCount"] == 2
