"""MarketDataSyncService — 分类级接口优先级链（ADR-002 方案 X）单元测试。

不触真实网络：用 monkeypatch 替换 ``_call_interface`` 注入响应 / 异常。
覆盖：
- fallback 顺序 + Q1「HTTP 200 但业务返回空」向下一接口；
- 网络异常（超时 / 连接错误）同样计为无响应向下；
- 全部无响应 → 返回空、source=None，且各接口计失败；
- 连续失败计数 + 达阈值抢占 alerted（去重）；
- sync_portfolio_prices：按 code 匹配证券 upsert SecurityPrice（带 fetched_at/source），
  并触发 recalculateRange 重建快照/净值。

测试库在会话内共享，_clean_db 每个测试前 TRUNCATE 全表，测试内自行建数据。
"""
from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal
from typing import Any, Optional

import pytest
from sqlalchemy import select

from app.models.enums import QuoteProviderAccessMethod, SecurityType
from app.models.interface_category import InterfaceCategory
from app.models.portfolio import Portfolio
from app.models.quote_interface import QuoteInterface
from app.models.quote_provider import SecuritiesDataProvider
from app.models.security import PortfolioSecurity, Security, SecurityPrice
from app.models.user import User
from app.services.market_data_sync import MarketDataSyncService, QUOTE_CAT_ID
from app.services.recalculation import RecalculationService

pytestmark = pytest.mark.asyncio


def _uid() -> str:
    return str(uuid.uuid4())


async def _seed_provider_category(session, *, priority_seq=(1, 2)):
    """建 提供方 + 分类 + 两个接口（priority 1/2 默认），返回 (provider, category, [itf1, itf2])。"""
    provider = SecuritiesDataProvider(
        id=_uid(),
        name="小熊同学",
        access_method=QuoteProviderAccessMethod.HTTPS,
        config={"base_url": "https://x.example.com"},
        enabled=True,
    )
    # 行情接口归属「证券行情」固定分类（reform 后 sync_portfolio_prices 按 QUOTE_CAT_ID 路由）
    category = InterfaceCategory(id=QUOTE_CAT_ID, label="证券行情", system=True)
    session.add_all([provider, category])
    await session.flush()
    itfs = []
    for i, pri in enumerate(priority_seq):
        itfs.append(
            QuoteInterface(
                id=_uid(),
                provider_id=provider.id,
                category_id=category.id,
                name=f"接口-{i+1}",
                endpoint=f"/q{i}",
                http_method="GET",
                enabled=True,
                priority=pri,
                resp_code_field="code",
                resp_price_field="price",
            )
        )
    session.add_all(itfs)
    await session.commit()
    return provider, category, itfs


async def _monkeypatch_call(service, mapping: dict[str, Any], errors: Optional[set[str]] = None):
    """按 interface id 决定返回值：mapping[id]=dict 表示业务数据；errors 集合中的 id 抛异常。"""
    errors = errors or set()

    async def _fake(itf: QuoteInterface, codes):
        if itf.id in errors:
            raise RuntimeError("network error")
        return mapping.get(itf.id, {})

    service._call_interface = _fake


async def test_fallback_order_business_empty_falls_through(session):
    """Q1：优先级最高接口返回「业务空」也计为无响应，向下一接口取数。"""
    provider, category, itfs = await _seed_provider_category(session)
    svc = MarketDataSyncService(session)
    # itf1（priority 1）业务空；itf2（priority 2）返回数据
    await _monkeypatch_call(svc, {itfs[1].id: {"600000": Decimal("10.50")}})

    result = await svc.fallback_fetch(category.id, ["600000", "000001"])

    assert result.prices == {"600000": Decimal("10.50")}
    assert result.source == f"{provider.name}/{itfs[1].name}"

    await session.refresh(itfs[0])
    await session.refresh(itfs[1])
    # itf1 被记失败，itf2 记成功复位
    assert itfs[0].consecutive_failures == 1
    assert itfs[1].consecutive_failures == 0
    assert itfs[1].alerted is False


async def test_fallback_network_error_falls_through(session):
    """网络异常（超时/连接错误）同样计无响应，向下一接口。"""
    provider, category, itfs = await _seed_provider_category(session)
    svc = MarketDataSyncService(session)
    await _monkeypatch_call(
        svc,
        {itfs[1].id: {"000001": Decimal("99.00")}},
        errors={itfs[0].id},
    )

    result = await svc.fallback_fetch(category.id, ["600000", "000001"])

    assert result.prices == {"000001": Decimal("99.00")}
    await session.refresh(itfs[0])
    assert itfs[0].consecutive_failures == 1


async def test_fallback_all_empty_returns_none(session):
    """全部接口无响应 → 空数据、source=None，且各接口计失败。"""
    _, category, itfs = await _seed_provider_category(session)
    svc = MarketDataSyncService(session)
    await _monkeypatch_call(svc, {})  # 两接口都返回 {}

    result = await svc.fallback_fetch(category.id, ["600000"])

    assert result.prices == {}
    assert result.source is None
    await session.refresh(itfs[0])
    await session.refresh(itfs[1])
    assert itfs[0].consecutive_failures == 1
    assert itfs[1].consecutive_failures == 1


async def test_failure_counting_and_alert_preemption(session):
    """连续失败达阈值（默认 3）抢占 alerted=True（去重），后续失败不再重复抢占。"""
    provider, category, itfs = await _seed_provider_category(session)
    svc = MarketDataSyncService(session)

    for _ in range(3):
        await svc._mark_failure(itfs[0])
    await session.refresh(itfs[0])
    assert itfs[0].consecutive_failures == 3
    assert itfs[0].alerted is True  # 第 3 次抢占告警

    # 第 4 次：已 alerted，计数继续增长但不重复置位
    await svc._mark_failure(itfs[0])
    await session.refresh(itfs[0])
    assert itfs[0].consecutive_failures == 4
    assert itfs[0].alerted is True


async def test_mark_success_resets_failures(session):
    """成功响应复位 consecutive_failures=0 且 alerted=False。"""
    provider, category, itfs = await _seed_provider_category(session)
    svc = MarketDataSyncService(session)
    await svc._mark_failure(itfs[0])
    await svc._mark_failure(itfs[0])
    await session.refresh(itfs[0])
    assert itfs[0].consecutive_failures == 2

    await svc._mark_success(itfs[0].id)
    await session.refresh(itfs[0])
    assert itfs[0].consecutive_failures == 0
    assert itfs[0].alerted is False


async def test_sync_portfolio_prices_upserts_and_recalculates(session, monkeypatch):
    """组合级同步：按 code 匹配证券 upsert SecurityPrice（fetched_at/source），并触发 recalculateRange。"""
    # 用户 + 组合（FK 约束需要真实 user 行）
    user = User(
        id=_uid(),
        email=f"sync_{uuid.uuid4().hex[:8]}@example.com",
        password_hash="x",
        role="user",
    )
    session.add(user)
    await session.flush()
    portfolio = Portfolio(id=_uid(), user_id=user.id, name="组合A")
    session.add(portfolio)
    await session.flush()

    m1 = Security(id=_uid(), asset_class=SecurityType.STOCK, code="600000", name="浦发")
    m2 = Security(id=_uid(), asset_class=SecurityType.STOCK, code="000001", name="平安")
    session.add_all([m1, m2])
    await session.flush()
    sec1 = PortfolioSecurity(id=_uid(), portfolio_id=portfolio.id, master_id=m1.id, type=SecurityType.STOCK)
    sec2 = PortfolioSecurity(id=_uid(), portfolio_id=portfolio.id, master_id=m2.id, type=SecurityType.STOCK)
    session.add_all([sec1, sec2])

    provider, category, itfs = await _seed_provider_category(session)
    # 该分类下接口返回两证券的价
    svc = MarketDataSyncService(session)
    await _monkeypatch_call(
        svc,
        {
            itfs[0].id: {
                "600000": Decimal("12.34"),
                "000001": Decimal("56.78"),
            }
        },
    )

    # 记录 recalculateRange 调用
    calls: list[tuple] = []

    async def _fake_recalculate(self, portfolio_id, start, end=None, force_dates=None):
        calls.append((portfolio_id, start, end))
        return None

    monkeypatch.setattr(RecalculationService, "recalculateRange", _fake_recalculate)

    result = await svc.sync_portfolio_prices(portfolio.id)
    await session.commit()

    assert result["synced"] == 2
    assert result["failed"] == 0

    # SecurityPrice 已 upsert
    rows = (
        await session.execute(
            select(SecurityPrice).where(SecurityPrice.portfolio_id == portfolio.id)
        )
    ).scalars().all()
    by_code = {r.security.master.code: r for r in rows}
    assert set(by_code.keys()) == {"600000", "000001"}
    assert by_code["600000"].price == Decimal("12.34")
    assert by_code["600000"].source == f"{provider.name}/{itfs[0].name}"
    assert by_code["600000"].fetched_at is not None
    assert by_code["600000"].fetched_at.tzinfo is not None  # timezone-aware

    # recalculateRange 被调用一次，且区间含 as_of（今天）
    assert len(calls) == 1
    assert calls[0][0] == portfolio.id
    assert isinstance(calls[0][1], date)


async def test_interfaces_for_category_orders_by_priority(session):
    """_interfaces_for_category 仅返回 enabled 接口，且按 priority 升序。"""
    provider, category, itfs = await _seed_provider_category(session)
    # 额外加一个 disabled 接口
    disabled = QuoteInterface(
        id=_uid(),
        provider_id=provider.id,
        category_id=category.id,
        name="禁用接口",
        enabled=False,
        priority=0,
    )
    session.add(disabled)
    await session.commit()

    svc = MarketDataSyncService(session)
    ordered = await svc._interfaces_for_category(category.id)
    ids = [o.id for o in ordered]
    assert disabled.id not in ids  # 禁用不被选中
    assert ids == [itfs[0].id, itfs[1].id]  # priority 1 在前


# --------------------------------------------------------------------------- #
# 数组行响应（如小熊同学 /stock/all → [[code, name], ...]）解析
# --------------------------------------------------------------------------- #
async def test_normalize_rows_keeps_array_rows():
    """{data: [[code,name],...]} 应保留数组行（dict 行也保留），不被过滤成 []。"""
    svc = MarketDataSyncService(None)  # type: ignore[arg-type]
    payload = {
        "code": 200,
        "data": [
            ["sz301141", "中科磁业"],
            ["sh600000", "浦发银行"],
        ],
    }
    rows = svc._normalize_rows(payload)
    assert len(rows) == 2
    assert rows[0] == ["sz301141", "中科磁业"]
    assert rows[1] == ["sh600000", "浦发银行"]


async def test_parse_price_rows_positional_indices():
    """数组行按 resp_* 配置的位置下标解析（0=code, 2=price）。"""
    svc = MarketDataSyncService(None)  # type: ignore[arg-type]
    itf = QuoteInterface(
        id="i1", provider_id="p1", category_id="c1", name="t",
        resp_code_field="0", resp_price_field="2",
    )
    rows = [
        ["600000", "浦发银行", "10.50"],
        ["000001", "平安银行", "9.87"],
    ]
    parsed = svc._parse_price_rows(itf, rows)
    # 价格 code 同样规范为「交易所前缀 + 数字」（600000→SH，000001→SZ）
    assert parsed == {"sh600000": Decimal("10.50"), "sz000001": Decimal("9.87")}


async def test_parse_price_rows_array_missing_price_skipped():
    """数组行缺价格（如 [code, name] 且 price 字段非数字下标）→ 跳过不报错。"""
    svc = MarketDataSyncService(None)  # type: ignore[arg-type]
    itf = QuoteInterface(
        id="i2", provider_id="p1", category_id="c1", name="t",
        resp_code_field="0", resp_price_field="price",  # 数组行无 price 字段名
    )
    parsed = svc._parse_price_rows(itf, [["600000", "浦发银行"]])
    assert parsed == {}
