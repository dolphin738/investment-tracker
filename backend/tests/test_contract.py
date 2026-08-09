"""契约冒烟测试 — 验证信封形状 / 错误码 / Decimal→str / JWT 鉴权 / OpenAPI。

运行：cd backend && python -m pytest
"""
from __future__ import annotations

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
