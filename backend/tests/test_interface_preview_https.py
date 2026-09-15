"""HTTPS 提供方的新增态实调预览（preview_https_interface / preview 端点）。

覆盖（mock 点统一为 market_data_fetch._get_shared_http_client，不触网）：
- JSON 成功：_normalize_rows 解 data 包 + httpStatus=200 + rowCount；
- text_split 成功：腾讯财经 ``q=`` 内联形态 + gbk 解码 + 行提取正则；
- 缺 base_url / 非法 scheme（SSRF 拦截）→ ok:false + 中文原因，不 500；
- 上游 5xx / 401 → ok:false + 上游状态码回传；
- 网络异常（ConnectError）/ 超时 → ok:false + 中文原因；
- codes 内联拼接（endpoint 以 = 结尾时 URL 末尾拼上 joined codes）；
- code_prefix=auto 补全（纯数字补 sh/sz 前缀）；
- 纯预览不写库：探测成功与失败后接口表计数均为 0。

不写库的保证：preview_https_interface 构造的 QuoteInterface 不入 session
（未 add），_fetch_https_raw 只做读（session.get 提供方）与限流键引用。
"""
from __future__ import annotations

import asyncio
import uuid
from typing import Any, Optional

import httpx
import pytest
from sqlalchemy import func, select, update

import app.services.market_data_fetch as mds
from app.models import User
from app.models.enums import QuoteProviderAccessMethod
from app.models.quote_interface import QuoteInterface
from app.models.quote_provider import SecuritiesDataProvider
from app.services.interface_preview import preview_https_interface
from tests.helpers import auth, env, register_login

pytestmark = pytest.mark.asyncio


def _uid() -> str:
    return str(uuid.uuid4())


# --------------------------------------------------------------------------- #
# 替身：httpx.AsyncClient / Response（与 test_response_parse.py 同调用契约）
# --------------------------------------------------------------------------- #
class _FakeResp:
    """响应替身：json() 走 JSON 分支；text 按 encoding 解码（验证 gbk 路径）。"""

    def __init__(
        self,
        *,
        json_data: object | None = None,
        content: bytes | None = None,
        text: str | None = None,
        status: int = 200,
    ) -> None:
        self.status_code = status
        self._json = json_data
        self._content = (
            content if content is not None else (text or "").encode("utf-8")
        )
        self.encoding: str | None = None  # _fetch_https_raw 按需赋 gbk / utf-8

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("err", request=None, response=self)  # type: ignore[arg-type]

    @property
    def text(self) -> str:
        return self._content.decode(self.encoding or "utf-8")

    def json(self) -> object:
        assert self._json is not None
        return self._json


class _FakeClient:
    """客户端替身：记录最后一次 (method, url, params)，可注入延迟与异常。"""

    def __init__(
        self,
        resp: Optional[_FakeResp] = None,
        *,
        delay: float = 0.0,
        exc: Optional[BaseException] = None,
    ) -> None:
        self._resp = resp
        self._delay = delay
        self._exc = exc
        self.last: tuple[str, str, Optional[dict[str, Any]]] = ("", "", None)

    async def __aenter__(self) -> "_FakeClient":
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False

    async def request(
        self, method: str, url: str, params=None, **kwargs: Any
    ) -> _FakeResp:
        self.last = (method, url, params)
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._exc is not None:
            raise self._exc
        assert self._resp is not None
        return self._resp


class _Patch:
    """monkeypatch _get_shared_http_client 的上下文管理器（退出即还原）。"""

    def __init__(self, client: _FakeClient) -> None:
        self._client = client
        self._original = mds._get_shared_http_client

    def __enter__(self) -> _FakeClient:
        mds._get_shared_http_client = lambda: self._client  # type: ignore[assignment]
        return self._client

    def __exit__(self, *exc: object) -> bool:
        mds._get_shared_http_client = self._original  # type: ignore[assignment]
        return False


# --------------------------------------------------------------------------- #
# 夹具：HTTPS 提供方 + 管理员
# --------------------------------------------------------------------------- #
async def _seed_https_provider(
    session, base_url: Optional[str] = "https://api.test"
) -> SecuritiesDataProvider:
    config: dict[str, Any] = {} if base_url is None else {"base_url": base_url}
    provider = SecuritiesDataProvider(
        id=_uid(), name="HTTPS 预览源",
        access_method=QuoteProviderAccessMethod.HTTPS.value,
        config=config, enabled=True,
    )
    session.add(provider)
    await session.commit()
    return provider


async def _admin(session, client, email: str) -> dict[str, Any]:
    info = await register_login(client, email=email)
    await session.execute(update(User).where(User.email == email).values(role="admin"))
    await session.commit()
    return info


async def _post_preview(client, token: str, body: dict[str, Any]):
    return await client.post(
        "/api/admin/quote-interfaces/preview", json=body, headers=auth(token)
    )


async def _interface_count(session) -> int:
    """接口表计数（纯预览不写库的断言）。"""
    return int(
        await session.scalar(select(func.count()).select_from(QuoteInterface)) or 0
    )


# --------------------------------------------------------------------------- #
# 成功路径
# --------------------------------------------------------------------------- #
async def test_preview_https_json_success(session, client):
    """HTTPS + JSON：解 data 包回传 raw + rowCount + httpStatus=200，且不写库。"""
    info = await _admin(session, client, "https_ok@example.com")
    provider = await _seed_https_provider(session)
    fake = _FakeClient(
        _FakeResp(json_data={"code": 0, "data": [{"code": "sz000001", "price": "15.00"}]})
    )

    with _Patch(fake):
        r = await _post_preview(
            client,
            info["token"],
            {
                "endpoint": "api/stock/list",
                "provider_id": provider.id,
                "params": {"region": "HK"},
                "response_parse": {"format": "json"},
                "http_method": "GET",
            },
        )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["ok"] is True and data["status"] == "success"
    assert data["raw"] == [{"code": "sz000001", "price": "15.00"}]
    assert data["rowCount"] == 1
    assert data["httpStatus"] == 200
    method, url, params = fake.last
    assert method == "GET"
    assert url == "https://api.test/api/stock/list"
    assert params == {"region": "HK"}
    # 纯预览：不写库
    assert await _interface_count(session) == 0


async def test_preview_https_text_split_inline_codes(session, client):
    """HTTPS + text_split：腾讯 ``q=`` 内联形态 + gbk 解码 + 行提取正则。"""
    info = await _admin(session, client, "https_text@example.com")
    provider = await _seed_https_provider(session, "https://qt.gtimg.cn")
    sample = (
        'v_sz000001="51~平安银行~000001~15.00~14.80";'
        'v_hk00700="100~腾讯控股~00700~400.00~395.00"'
    )
    fake = _FakeClient(_FakeResp(content=sample.encode("gbk")))

    with _Patch(fake):
        r = await _post_preview(
            client,
            info["token"],
            {
                "endpoint": "q=",
                "provider_id": provider.id,
                "response_parse": {
                    "format": "text_split",
                    "encoding": "gbk",
                    "sep": "~",
                    "line_regex": r'v_(\w+)="([^"]*)"',
                    "code_param": "q",
                },
                "codes": ["sz000001", "hk00700"],
            },
        )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["ok"] is True
    assert data["rowCount"] == 2
    assert data["raw"][0]["_code"] == "sz000001"
    assert "平安银行" in data["raw"][0]["1"]
    assert data["raw"][1]["_code"] == "hk00700"
    # 内联形态：代码拼到 URL 末尾（无 ?code=）
    _, url, params = fake.last
    assert url.endswith("q=sz000001,hk00700")
    assert "code=" not in url
    assert params == {}


# --------------------------------------------------------------------------- #
# 探测失败（ok:false + 中文原因，不 500）
# --------------------------------------------------------------------------- #
async def test_preview_https_missing_base_url(session, client):
    """提供方未配 base_url → ok:false + 中文原因（不 500、不写库）。"""
    info = await _admin(session, client, "https_nobase@example.com")
    provider = await _seed_https_provider(session, base_url=None)

    r = await _post_preview(
        client,
        info["token"],
        {"endpoint": "api/stock/list", "provider_id": provider.id},
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["ok"] is False and data["status"] == "error"
    assert "缺少 base_url" in data["error"]
    assert data["raw"] is None
    assert await _interface_count(session) == 0


async def test_preview_https_rejects_unsafe_scheme(session, client):
    """非法 scheme（ftp://）→ SSRF 拦截，ok:false + 中文原因。"""
    info = await _admin(session, client, "https_ftp@example.com")
    provider = await _seed_https_provider(session, "ftp://api.test")

    r = await _post_preview(
        client,
        info["token"],
        {"endpoint": "api/stock/list", "provider_id": provider.id},
    )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["ok"] is False
    assert "不允许的 URL scheme" in data["error"]


async def test_preview_https_upstream_5xx(session, client):
    """上游 5xx → ok:false +「上游 5xx」+ httpStatus 回传。"""
    info = await _admin(session, client, "https_5xx@example.com")
    provider = await _seed_https_provider(session)
    fake = _FakeClient(_FakeResp(json_data={}, status=503))

    with _Patch(fake):
        r = await _post_preview(
            client,
            info["token"],
            {"endpoint": "api/stock/list", "provider_id": provider.id},
        )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["ok"] is False
    assert "上游 5xx" in data["error"]
    assert data["httpStatus"] == 503


async def test_preview_https_auth_failure(session, client):
    """上游 401 → ok:false +「鉴权失败」。"""
    info = await _admin(session, client, "https_401@example.com")
    provider = await _seed_https_provider(session)
    fake = _FakeClient(_FakeResp(json_data={}, status=401))

    with _Patch(fake):
        r = await _post_preview(
            client,
            info["token"],
            {"endpoint": "api/stock/list", "provider_id": provider.id},
        )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["ok"] is False
    assert "鉴权失败" in data["error"]
    assert data["httpStatus"] == 401


async def test_preview_https_network_error(session, client):
    """网络异常（ConnectError）→ ok:false +「无法连接上游服务」，不 500。"""
    info = await _admin(session, client, "https_net@example.com")
    provider = await _seed_https_provider(session)
    fake = _FakeClient(exc=httpx.ConnectError("All connection attempts failed"))

    with _Patch(fake):
        r = await _post_preview(
            client,
            info["token"],
            {"endpoint": "api/stock/list", "provider_id": provider.id},
        )
    status, code, data, _ = env(r)
    assert status == 200 and code == 0
    assert data["ok"] is False
    assert "无法连接上游服务" in data["error"]


async def test_preview_https_timeout(session):
    """超时（小 timeout_seconds 直调服务函数）→ ok:false +「调用超时」。"""
    provider = await _seed_https_provider(session)
    fake = _FakeClient(_FakeResp(json_data={"data": []}), delay=0.2)

    with _Patch(fake):
        result = await preview_https_interface(
            session, provider.id, "api/stock/list", timeout_seconds=0.05
        )
    assert result["ok"] is False
    assert "调用超时" in result["error"]
    assert result["raw"] is None


# --------------------------------------------------------------------------- #
# 代码拼接与前缀补全
# --------------------------------------------------------------------------- #
async def test_preview_https_inline_codes_join(session, client):
    """endpoint 以 `=` 结尾时，codes 以逗号拼接追加到 URL 末尾。"""
    info = await _admin(session, client, "https_inline@example.com")
    provider = await _seed_https_provider(session)
    fake = _FakeClient(_FakeResp(json_data={"data": []}))

    with _Patch(fake):
        r = await _post_preview(
            client,
            info["token"],
            {
                "endpoint": "q=",
                "provider_id": provider.id,
                "response_parse": {"format": "json"},
                "codes": ["sh600519", "sz000001"],
            },
        )
    assert env(r)[0] == 200
    _, url, _params = fake.last
    assert url == "https://api.test/q=sh600519,sz000001"


async def test_preview_https_auto_code_prefix(session, client):
    """code_prefix=auto：纯数字代码按交易所补前缀后作为 code 参数发出。"""
    info = await _admin(session, client, "https_prefix@example.com")
    provider = await _seed_https_provider(session)
    fake = _FakeClient(_FakeResp(json_data={"data": []}))

    with _Patch(fake):
        r = await _post_preview(
            client,
            info["token"],
            {
                "endpoint": "api/stock/quote",
                "provider_id": provider.id,
                "response_parse": {"format": "json", "code_prefix": "auto"},
                "codes": ["600519", "000001", "sh600519"],
            },
        )
    assert env(r)[0] == 200
    _, _url, params = fake.last
    assert params == {"code": "sh600519,sz000001,sh600519"}


async def test_preview_https_ignores_blank_codes(session, client):
    """codes 全为空白项 → 视为未填（不发 code 参数），不报错。"""
    info = await _admin(session, client, "https_blank@example.com")
    provider = await _seed_https_provider(session)
    fake = _FakeClient(_FakeResp(json_data={"data": []}))

    with _Patch(fake):
        r = await _post_preview(
            client,
            info["token"],
            {
                "endpoint": "api/stock/quote",
                "provider_id": provider.id,
                "codes": ["", "   "],
            },
        )
    assert env(r)[0] == 200
    _, _url, params = fake.last
    assert params == {}
