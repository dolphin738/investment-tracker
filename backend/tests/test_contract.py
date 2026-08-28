"""契约冒烟测试 — 验证信封形状 / 错误码 / Decimal→str / JWT 鉴权 / OpenAPI。

运行：cd backend && python -m pytest
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
import types
from fastapi.testclient import TestClient

from app.core.security import create_access_token, decode_access_token
from app.main import app

client = TestClient(app)


def test_health_envelope_shape():
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body == {
        "code": 0,
        "data": {"status": "ok", "service": "investment_return_tracker"},
        "message": "ok",
    }


def test_data_none_normalized_to_null():
    r = client.get("/api/empty")
    assert r.status_code == 200
    body = r.json()
    assert body["code"] == 0
    assert body["data"] is None
    assert body["message"] == "ok"


def test_bare_decimal_serialized_as_string():
    r = client.get("/api/echo")
    body = r.json()
    assert body["code"] == 0
    # 关键：金额必须是字符串，不能是 number（防精度漂移）
    assert body["data"]["amount"] == "1234.50"
    assert isinstance(body["data"]["amount"], str)


def test_decimal_str_dto_serialized_as_string():
    r = client.get("/api/decimal-model")
    body = r.json()
    assert body["data"]["amount"] == "999.99"
    assert body["data"]["fee"] == "0.05"
    assert isinstance(body["data"]["amount"], str)


def test_business_exception_envelope():
    r = client.get("/api/boom")
    assert r.status_code == 404
    body = r.json()
    assert body["code"] == 3001
    assert body["data"] is None
    assert body["message"] == "组合不存在"


def test_protected_requires_auth():
    r = client.get("/api/protected")
    assert r.status_code == 401
    assert r.json()["code"] == 1001


def test_protected_with_valid_token():
    tok = client.get("/api/token").json()["data"]["token"]
    r = client.get("/api/protected", headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 200
    body = r.json()
    assert body["code"] == 0
    assert body["data"]["user_id"] == "demo-user-id"


def test_jwt_roundtrip():
    t = create_access_token("u1", "a@b.com")
    p = decode_access_token(t)
    assert p["sub"] == "u1"
    assert p["email"] == "a@b.com"


def test_openapi_has_bearer_security():
    spec = client.get("/api/openapi.json").json()
    assert "JWT-auth" in spec["components"]["securitySchemes"]
    # openapi 路由本身不被信封包裹（Swagger 需要原始 schema）
    assert "paths" in spec
    assert "/api/health" in spec["paths"]


def test_openapi_enum_schemas_extracted():
    """§5.2b：枚举应作为独立命名 schema 出现，且被实体/行错误引用（$ref）。"""
    spec = client.get("/api/openapi.json").json()
    schemas = spec["components"]["schemas"]
    for name in [
        "CashFlowType",
        "SecurityType",
        "SecuritySide",
        "SnapshotSource",
        "SnapshotValuation",
        "DividendType",
        "ExportType",
        "ImportType",
        "ImportErrorCode",
    ]:
        assert name in schemas, f"{name} 应作为独立命名 schema 出现在 OpenAPI"
        assert "enum" in schemas[name], f"{name} 应为枚举 schema"
    # 导入行错误引用 ImportErrorCode 命名 schema
    assert "ImportRowError" in schemas
    assert (
        schemas["ImportRowError"]["properties"]["code"]["$ref"]
        == "#/components/schemas/ImportErrorCode"
    )
    # 实体响应体引用枚举命名 schema
    assert (
        schemas["CashflowOut"]["properties"]["type"]["$ref"]
        == "#/components/schemas/CashFlowType"
    )
    assert (
        schemas["ImportPreviewOut"]["properties"]["type"]["$ref"]
        == "#/components/schemas/ImportType"
    )


def test_swagger_ui_reachable():
    r = client.get("/api/docs")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]


def _ns(**kw):
    return types.SimpleNamespace(**kw)


def test_serializers_keys_match_schemas_resp():
    """REP-038 防漂移护栏：serializers.py 字段集须与 schemas_resp.py 的 XxxOut 对齐。

    背景：serializers.py 的 serialize_x 与 schemas_resp.py 的 XxxOut 各自维护一份
    字段清单（双维护）。强行合并会破坏 wire 契约（风险高），故只加护栏：
    - 序列化器输出的每个键都必须在对应 Out 模型中有声明（禁止 wire 出现 schema 未记录的键）。
    - 对无「路由层追加字段」的实体，额外要求键集严格相等（新增字段必须同步到响应模型）。
    - cashflow 为已知特例：recalculation 由 data/router 在序列化后追加，序列化器有意缺该键 → 仅校验子集。
    """
    from app import serializers, schemas_resp as S
    from app.models.enums import (
        CashFlowType,
        DividendType,
        SecuritySide,
        SnapshotSource,
        SnapshotValuation,
    )

    portfolio = _ns(
        id="p1", user_id="u1", name="组合", description=None, base_date=date(2024, 1, 1),
        currency="CNY", archived_at=None, created_at=datetime(2024, 1, 1), updated_at=datetime(2024, 1, 2),
    )
    cashflow = _ns(
        id="c1", portfolio_id="p1", date=date(2024, 1, 1), type=CashFlowType.BUY,
        amount="100.00", note=None, created_at=datetime(2024, 1, 1), updated_at=datetime(2024, 1, 2),
    )
    security = _ns(
        id="s1", master_id="m1", currency="CNY", created_at=datetime(2024, 1, 1), updated_at=datetime(2024, 1, 2),
        type=None,
        master=_ns(code="600000", exchange="SH", name="测试股"),
    )
    trade = _ns(
        id="t1", security_id="s1", date=date(2024, 1, 1), side=SecuritySide.BUY_SEC,
        quantity="10", cost_price="1.00", commission="0.01", stamp_tax="0.00",
        other="0.00", fee_total="0.01", note=None,
        created_at=datetime(2024, 1, 1), updated_at=datetime(2024, 1, 2),
    )
    price = _ns(
        id="pr1", security_id="s1", price="9.99", as_of=date(2024, 1, 1),
        created_at=datetime(2024, 1, 1),
    )
    cashbalance = _ns(
        id="cb1", amount="500.00", as_of=date(2024, 1, 1), note=None,
        created_at=datetime(2024, 1, 1),
    )
    snapshot = _ns(
        id="sn1", portfolio_id="p1", date=date(2024, 1, 1), total_asset="1000.00",
        market_value="900.00", cash_balance="100.00", source=SnapshotSource.DERIVED,
        valuation_flag=SnapshotValuation.EXACT, note=None, recorded_at=datetime(2024, 1, 1),
        created_at=datetime(2024, 1, 1), updated_at=datetime(2024, 1, 2),
    )
    dividend = _ns(
        id="d1", security_id="s1", date=date(2024, 1, 1), amount=Decimal("10.00"), tax=Decimal("1.00"),
        type=DividendType.CASH, note=None, created_at=datetime(2024, 1, 1),
    )
    preference = _ns(
        id="pf1", default_portfolio_id="p1", default_granularity="day", default_date_range="1m",
        aggregation="sum", week_starts_on=1, nav_decimals=2, xirr_decimals=2, theme="light",
        stale_days=7, show_liquidated=False, cost_basis_view="cost", cash_hint_on_cashflow=True,
        cash_hint_on_trade=False, amount_thousands=True, amount_abbrev=False, dashboard_layout="{}",
    )
    user = _ns(
        id="u1", email="a@b.com", name="N", avatar=None, phone=None, bio=None,
        role="user", created_at=datetime(2024, 1, 1),
    )

    cases = [
        (serializers.serialize_portfolio, S.PortfolioOut, portfolio),
        (serializers.serialize_cashflow, S.CashflowOut, cashflow),
        (serializers.serialize_security, S.SecurityOut, security),
        (serializers.serialize_trade, S.TradeOut, trade),
        (serializers.serialize_price, S.PriceOut, price),
        (serializers.serialize_cashbalance, S.CashBalanceOut, cashbalance),
        (serializers.serialize_snapshot, S.SnapshotOut, snapshot),
        (serializers.serialize_dividend, S.DividendOut, dividend),
        (serializers.serialize_preference, S.PreferenceOut, preference),
        (serializers.serialize_user, S.UserPublicOut, user),
    ]
    # 已知「序列化器有意缺字段」（由路由层追加）的实体 → 仅校验子集关系
    subset_only = {S.CashflowOut}

    for serialize, out_model, sample in cases:
        keys = set(serialize(sample).keys())
        fields = set(out_model.model_fields.keys())
        extra = keys - fields
        assert not extra, (
            f"{serialize.__name__} 输出未声明键 {sorted(extra)} "
            f"（schemas_resp.{out_model.__name__} 缺少对应字段）"
        )
        if out_model in subset_only:
            continue
        missing = fields - keys
        assert not missing, (
            f"{serialize.__name__} 缺失字段 {sorted(missing)} "
            f"（schemas_resp.{out_model.__name__} 已声明但未出现在序列化输出）"
        )
