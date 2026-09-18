"""Phase 3 集成测试辅助函数（被各 test_* 模块导入）。

提供：注册+登录拿 token、构造鉴权头、信封响应解析。
"""
from __future__ import annotations

from typing import Any

from httpx import AsyncClient


async def register_login(
    client: AsyncClient,
    email: str = "alice@example.com",
    password: str = "secret123",
    name: str = "Alice",
) -> dict[str, Any]:
    """注册并登录，返回 {token, user_id, email}。"""
    r = await client.post(
        "/api/auth/register",
        json={"email": email, "password": password, "name": name},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["code"] == 0, body
    uid = body["data"]["id"]
    r = await client.post(
        "/api/auth/login", json={"email": email, "password": password}
    )
    assert r.status_code == 200, r.text
    token = r.json()["data"]["accessToken"]
    return {"token": token, "user_id": uid, "email": email}


def auth(token: str) -> dict[str, str]:
    """Bearer 鉴权头。"""
    return {"Authorization": f"Bearer {token}"}


def env(resp) -> tuple[int, int, Any, Any]:
    """解析信封响应 → (http_status, code, data, message)。"""
    j = resp.json()
    return resp.status_code, j.get("code"), j.get("data"), j.get("message")


async def seed_security(
    client: AsyncClient,
    pid: str,
    code: str,
    name: str,
    h: dict[str, str],
    type: str | None = None,
    asset_class: Any | None = None,
    exchange: str | None = None,
) -> str:
    """ADR-003 拆表后建证券标的的标准路径：先建目录主数据 Security，再 resolve 出组合持仓。

    返回组合持仓（portfolio_securities）id，供 trade/price/dividend 的 securityId 使用。
    替代已移除的 POST /api/portfolios/{pid}/securities（D3 删除 Security.create）。
    """
    import app.db.database as dbmod
    from app.models import Security, SecurityType

    async with dbmod.AsyncSessionLocal() as s:
        master = Security(
            code=code,
            name=name,
            exchange=exchange,
            asset_class=asset_class or SecurityType.STOCK,
        )
        s.add(master)
        await s.commit()
        await s.refresh(master, ["id"])
        mid = master.id

    body = {"masterId": mid}
    if type is not None:
        body["type"] = type
    r = await client.post(
        f"/api/portfolios/{pid}/securities/resolve", headers=h, json=body
    )
    assert r.status_code == 200, r.text
    return r.json()["data"]["id"]


# ---------------------------------------------------------------------------
# 以下 helper 原位于 tests/helpers_price_backfill.py，因 price-gap 回补子系统下线而迁入此
# 共享模块（仅保留与日线抓取 / 行情源相关的非回补专用构造器；seed_sdk_quote_source 等
# 纯回补专用构造器随子系统一并移除）。
# ---------------------------------------------------------------------------
from app.models import (
    DividendYieldSettings,
    QuoteInterface,
    SecuritiesDataProvider,
    Security,
)
from app.models.enums import QuoteProviderAccessMethod, SecurityType
from app.models.interface_category import InterfaceCategory
from app.services.market_data_sync import (
    QUOTE_CAT_ID,
    _normalize_master_code,
    infer_exchange,
)

import uuid


def uid() -> str:
    return str(uuid.uuid4())


async def add_master(session, code="600000"):
    """造一只「证券」主数据（code 经 ``_normalize_master_code`` 规范化）。"""
    norm = _normalize_master_code(code, infer_exchange(code))
    m = Security(id=uid(), code=norm, name="浦发银行", asset_class=SecurityType.STOCK)
    session.add(m)
    await session.flush()
    return m


async def seed_https_quote_source(session, *, max_codes_per_request: int = 800):
    """造 HTTPS 行情源 + 配置表（price_source_interface_id 指向它），返回 itf。

    与既有内联造法等价，抽成辅助以复用；``max_codes_per_request`` 可控批次大小
    （置 1 即「每批 1 只」→ 便于构造「部分失败」场景）。
    """
    provider = SecuritiesDataProvider(
        id=uid(), name="腾讯", access_method=QuoteProviderAccessMethod.HTTPS,
        config={"base_url": "https://qt.gtimg.cn"}, enabled=True,
    )
    itf = QuoteInterface(
        id=uid(), provider_id=provider.id, category_id=QUOTE_CAT_ID, name="腾讯",
        endpoint="/q", http_method="GET", enabled=True, priority=1,
        resp_code_field="代码", resp_price_field="收盘",
        response_parse={"resp_date_field": "日期", "max_codes_per_request": max_codes_per_request},
        params={},
    )
    session.add(provider)
    await session.flush()  # 提供方先落库，接口 provider_id 外键才有归属
    session.add(InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True))
    await session.flush()
    session.add(itf)
    await session.flush()
    session.add(DividendYieldSettings(
                                      price_source_interface_id=itf.id))
    await session.flush()
    return itf
