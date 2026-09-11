"""POST /api/admin/quote-interfaces/preview — 新增态实调预览（端点 + 服务函数）。

覆盖（对齐既有 test_quote_interface 测试风格，走真实 ASGI app + 测试库）：
- 成功：monkeypatch sys.modules["akshare"] 桩 → ok:true + raw 原始行（拍平复用
  _flatten_dataframe_records）；params 为空 → 按 akshare 签名默认值调用（零 kwargs）；
- akshare 中不存在该函数 → ok:false + 明确中文错误（不 500）；
- akshare 未安装（ImportError）→ ok:false +「后端未安装 akshare，无法实调预览」；
- 提供方不存在 / 不支持的接入方式 → 400 明确中文错误（HTTPS 已改为走探测，不再 400）；
- 纯预览：不写库（QuoteInterface 表保持 0 行）；
- 超时路径：直接调服务函数（小超时）→ ok:false + 超时消息。
"""
from __future__ import annotations

import sys
import uuid
from typing import Any

import pytest
from sqlalchemy import func, select, update

from app.models import User
from app.models.enums import QuoteProviderAccessMethod
from app.models.quote_interface import QuoteInterface
from app.models.quote_provider import SecuritiesDataProvider
from app.services.interface_preview import preview_sdk_interface
from tests.helpers import auth, env, register_login

pytestmark = pytest.mark.asyncio


def _uid() -> str:
    return str(uuid.uuid4())


class _FakeRecordsDF:
    """含 to_dict("records") 的 DataFrame 替身（走 _flatten_dataframe_records 分支）。"""

    def __init__(self, records: list[dict[str, Any]]) -> None:
        self._records = records
        self.empty = not records

    def to_dict(self, orient: str = "records") -> list[dict[str, Any]]:
        assert orient == "records"
        return list(self._records)


class _FakeAkShare:
    """mock akshare：stock_zh_a_spot 返回两行原始数据。"""

    def __init__(self) -> None:
        self.last_kwargs: dict[str, Any] = {}

    def stock_zh_a_spot(self, **kwargs: Any) -> _FakeRecordsDF:
        self.last_kwargs = kwargs
        return _FakeRecordsDF(
            [
                {"code": "600000", "price": "12.34"},
                {"code": "000001", "price": "56.78"},
            ]
        )


class _SlowAkShare:
    """mock akshare：slow_func 睡眠，用于超时路径。"""

    @staticmethod
    def slow_func() -> None:
        import time

        time.sleep(0.2)


async def _seed_provider(
    session, *, access_method: QuoteProviderAccessMethod
) -> SecuritiesDataProvider:
    """按接入方式种一个提供方（SDK 带 sdk_name，HTTPS 带 base_url）。"""
    config: dict[str, Any] = (
        {"sdk_name": "akshare"}
        if access_method == QuoteProviderAccessMethod.SDK
        else {"base_url": "https://x.example.com"}
    )
    provider = SecuritiesDataProvider(
        id=_uid(), name="预览源", access_method=access_method.value,
        config=config, enabled=True,
    )
    session.add(provider)
    await session.commit()
    return provider


async def _admin(session, client, email: str) -> dict[str, Any]:
    """注册 + 提权为管理员 + 登录（对齐 test_response_fields_api 模式）。"""
    info = await register_login(client, email=email)
    await session.execute(update(User).where(User.email == email).values(role="admin"))
    await session.commit()
    return info


async def _post_preview(client, token: str, body: dict[str, Any]):
    return await client.post(
        "/api/admin/quote-interfaces/preview", json=body, headers=auth(token)
    )


# ───────────────────────── 端点：成功路径 ─────────────────────────
async def test_preview_success(session, client, monkeypatch):
    """SDK 提供方 + 存在的函数名 → ok:true + raw 行；params 空 → 零 kwargs。"""
    info = await _admin(session, client, "preview_ok@example.com")
    provider = await _seed_provider(session, access_method=QuoteProviderAccessMethod.SDK)
    fake = _FakeAkShare()
    monkeypatch.setitem(sys.modules, "akshare", fake)

    r = await _post_preview(
        client,
        info["token"],
        {"endpoint": "stock_zh_a_spot", "provider_id": provider.id, "params": {}},
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["ok"] is True and data["status"] == "success"
    assert data["raw"] == [
        {"code": "600000", "price": "12.34"},
        {"code": "000001", "price": "56.78"},
    ]
    assert data["rowCount"] == 2
    # params 为空 dict → 不透传任何 kwargs（按 akshare 签名默认值调用）
    assert fake.last_kwargs == {}
    # 纯预览：不写库（接口表保持 0 行）
    count = await session.scalar(select(func.count()).select_from(QuoteInterface))
    assert count == 0


async def test_preview_transfers_params(session, client, monkeypatch):
    """params 非空 → 原样透传给 akshare 函数。"""
    info = await _admin(session, client, "preview_params@example.com")
    provider = await _seed_provider(session, access_method=QuoteProviderAccessMethod.SDK)
    fake = _FakeAkShare()
    monkeypatch.setitem(sys.modules, "akshare", fake)

    r = await _post_preview(
        client,
        info["token"],
        {"endpoint": "stock_zh_a_spot", "provider_id": provider.id, "params": {"market": "sh"}},
    )
    assert env(r)[0] == 200
    assert fake.last_kwargs == {"market": "sh"}


# ───────────────────────── 端点：探测失败（ok:false，不 500） ─────────────────────────
async def test_preview_missing_function(session, client, monkeypatch):
    """akshare 中不存在该函数 → ok:false + 明确中文错误。"""
    info = await _admin(session, client, "preview_missing@example.com")
    provider = await _seed_provider(session, access_method=QuoteProviderAccessMethod.SDK)
    monkeypatch.setitem(sys.modules, "akshare", _FakeAkShare())

    r = await _post_preview(
        client,
        info["token"],
        {"endpoint": "no_such_func", "provider_id": provider.id},
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["ok"] is False and data["status"] == "error"
    assert "akshare 中不存在函数 no_such_func" in data["error"]


async def test_preview_akshare_not_installed(session, client, monkeypatch):
    """akshare 未安装（sys.modules 占位 None → import 抛 ImportError）→ 明确提示，不 500。"""
    info = await _admin(session, client, "preview_noak@example.com")
    provider = await _seed_provider(session, access_method=QuoteProviderAccessMethod.SDK)
    monkeypatch.setitem(sys.modules, "akshare", None)

    r = await _post_preview(
        client,
        info["token"],
        {"endpoint": "stock_zh_a_spot", "provider_id": provider.id},
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["ok"] is False
    assert data["error"] == "后端未安装 akshare，无法实调预览"


# ───────────────────────── 端点：请求校验 400 ─────────────────────────
async def test_preview_https_provider_probes_instead_of_400(session, client):
    """HTTPS 提供方：不再 400，改走 HTTPS 探测路径（缺 base_url → ok:false + 中文原因）。

    HTTPS 的成功 / SSRF / 上游错误等完整用例见 tests/test_interface_preview_https.py。
    """
    info = await _admin(session, client, "preview_https@example.com")
    provider = SecuritiesDataProvider(
        id=_uid(), name="HTTPS 源（未配 base_url）",
        access_method=QuoteProviderAccessMethod.HTTPS.value,
        config={}, enabled=True,
    )
    session.add(provider)
    await session.commit()

    r = await _post_preview(
        client,
        info["token"],
        {"endpoint": "api/stock/list", "provider_id": provider.id},
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["ok"] is False and data["status"] == "error"
    assert "缺少 base_url" in data["error"]
    # 纯预览：不写库（接口表保持 0 行）
    count = await session.scalar(select(func.count()).select_from(QuoteInterface))
    assert count == 0


async def test_preview_unknown_provider_returns_400(session, client):
    """提供方不存在 → 400 + 明确中文错误。"""
    info = await _admin(session, client, "preview_noprov@example.com")

    r = await _post_preview(
        client,
        info["token"],
        {"endpoint": "stock_zh_a_spot", "provider_id": _uid()},
    )
    status, code, _, message = env(r)
    assert status == 400 and code != 0
    assert "提供方不存在" in (message or "")


async def test_preview_requires_admin(session, client):
    """非管理员 → 403。"""
    info = await register_login(client, email="preview_nonadmin@example.com")
    r = await _post_preview(
        client,
        info["token"],
        {"endpoint": "stock_zh_a_spot", "provider_id": _uid()},
    )
    assert env(r)[0] == 403


# ───────────────────────── 服务函数：超时路径 ─────────────────────────
async def test_preview_service_timeout(monkeypatch):
    """实调超时 → ok:false + 超时消息（小超时直调服务函数验证）。"""
    monkeypatch.setitem(sys.modules, "akshare", _SlowAkShare())
    result = await preview_sdk_interface("slow_func", {}, timeout_seconds=0.05)
    assert result["ok"] is False
    assert "调用超时" in result["error"]
    assert result["raw"] is None


async def test_preview_service_empty_dataframe(monkeypatch):
    """空 DataFrame / None → raw 为空数组（成功语义，无列可预填由前端提示）。"""
    monkeypatch.setitem(sys.modules, "akshare", _FakeAkShare())

    class _Empty:
        empty = True

        def to_dict(self, orient: str = "records"):
            return []

    monkeypatch.setattr(_FakeAkShare, "stock_zh_a_spot", lambda self, **kw: _Empty())
    result = await preview_sdk_interface("stock_zh_a_spot", {})
    assert result["ok"] is True
    assert result["raw"] == [] and result["rowCount"] == 0
