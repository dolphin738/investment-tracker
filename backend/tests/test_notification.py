"""NotificationService + _mark_failure 告警写通知 — 单元测试。

覆盖（对应 ADR-002 §3 Q2 / 任务清单 T03、T04）：
- 连续 3 次无响应（_mark_failure 抢到告警）→ 恰好 1 条未读 Notification；
- mark_read 翻转 read；不存在 id → 404；
- NotificationService 直接 create / list_all / list_unread。
"""
from __future__ import annotations

import uuid

import pytest

from app.models.enums import QuoteProviderAccessMethod
from app.models.interface_category import InterfaceCategory
from app.models.quote_interface import QuoteInterface
from app.models.quote_provider import SecuritiesDataProvider
from app.services.market_data_sync import FAILURE_THRESHOLD, MarketDataSyncService
from app.services.notification import NotificationService

pytestmark = pytest.mark.asyncio


def _uid() -> str:
    return str(uuid.uuid4())


async def _seed_interface(session) -> QuoteInterface:
    """建 提供方 + 分类 + 一个接口（priority=1，已就绪可被 _mark_failure 计数）。"""
    provider = SecuritiesDataProvider(
        id=_uid(),
        name="小熊同学",
        access_method=QuoteProviderAccessMethod.HTTPS,
        config={"base_url": "https://x.example.com"},
        enabled=True,
    )
    cat = InterfaceCategory(id=_uid(), label="A股行情")
    session.add_all([provider, cat])
    await session.flush()
    itf = QuoteInterface(
        id=_uid(),
        provider_id=provider.id,
        category_id=cat.id,
        name="接口-1",
        enabled=True,
        priority=1,
        resp_code_field="code",
        resp_price_field="price",
    )
    session.add(itf)
    await session.commit()
    return itf


async def test_continuous_failures_create_one_unread_notification(session):
    """连续 N 次无响应 → 抢到告警写 恰好 1 条未读 Notification。"""
    itf = await _seed_interface(session)
    svc = MarketDataSyncService(session)
    for _ in range(FAILURE_THRESHOLD):
        await svc._mark_failure(itf)
    await session.flush()

    unread = await NotificationService(session).list_unread()
    assert len(unread) == 1
    n = unread[0]
    assert n.read is False
    assert n.level == "warning"
    assert n.related_type == "quote_interface"
    assert n.related_id == itf.id
    assert f"连续 {FAILURE_THRESHOLD} 次无响应" in n.title


async def test_mark_read_flips_and_404(session):
    """mark_read 翻转 read；不存在 id → 404。"""
    itf = await _seed_interface(session)
    svc = MarketDataSyncService(session)
    for _ in range(FAILURE_THRESHOLD):
        await svc._mark_failure(itf)
    await session.flush()

    items = await NotificationService(session).list_all()
    nid = items[0].id
    updated = await NotificationService(session).mark_read(nid)
    assert updated.read is True
    assert len(await NotificationService(session).list_unread()) == 0

    with pytest.raises(Exception) as exc:
        await NotificationService(session).mark_read(_uid())
    assert exc.value.status_code == 404


async def test_notification_service_crud(session):
    """NotificationService 基础 CRUD：create / list_all / list_unread。"""
    svc = NotificationService(session)
    await svc.create(
        level="info",
        title="t",
        message="m",
        related_type="quote_interface",
        related_id="x",
    )
    await session.flush()

    all_items = await svc.list_all()
    assert len(all_items) == 1
    assert all_items[0].level == "info"
    assert len(await svc.list_unread()) == 1
