"""QuoteInterfaceService.reorder + create 默认末位优先级 — 单元测试。

覆盖（对应 ADR-002 §2.5 / 任务清单 T02）：
- 同分类 reorder 后 priority 与顺序一致；
- 混入跨分类 id → 400；
- create 默认 priority 落该分类末位（COALESCE(MAX(priority),-1)+1）。
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from app.models.enums import QuoteProviderAccessMethod
from app.models.interface_category import InterfaceCategory
from app.models.quote_interface import QuoteInterface
from app.models.quote_provider import SecuritiesDataProvider
from app.services.quote_interface import QuoteInterfaceService

pytestmark = pytest.mark.asyncio


def _uid() -> str:
    return str(uuid.uuid4())


async def _seed(session, *, n: int = 3, category_id: str | None = None):
    """建 提供方 + 分类 + n 个接口（priority=0..n-1），返回 (provider, cat, [itfs])。"""
    provider = SecuritiesDataProvider(
        id=_uid(),
        name="P",
        access_method=QuoteProviderAccessMethod.HTTPS,
        config={"base_url": "https://x.example.com"},
        enabled=True,
    )
    cat = InterfaceCategory(id=category_id or _uid(), label="cat")
    session.add_all([provider, cat])
    await session.flush()
    iffs: list[QuoteInterface] = []
    for i in range(n):
        iffs.append(
            QuoteInterface(
                id=_uid(),
                provider_id=provider.id,
                category_id=cat.id,
                name=f"if{i}",
                enabled=True,
                priority=i,
            )
        )
    session.add_all(iffs)
    await session.commit()
    return provider, cat, iffs


async def test_reorder_same_category_priority_consistent(session):
    """同分类 reorder：priority 按传入顺序从 0 递增，列表顺序与 ordered_ids 一致。"""
    _, cat, iffs = await _seed(session, n=3)
    ordered_ids = [iffs[2].id, iffs[0].id, iffs[1].id]  # 任意新顺序
    await QuoteInterfaceService(session).reorder(cat.id, ordered_ids)
    await session.commit()

    rows = (
        await session.execute(
            select(QuoteInterface)
            .where(QuoteInterface.category_id == cat.id)
            .order_by(QuoteInterface.priority)
        )
    ).scalars().all()
    assert [r.id for r in rows] == ordered_ids
    assert [r.priority for r in rows] == [0, 1, 2]


async def test_reorder_cross_category_id_raises_400(session):
    """混入跨分类 id → 400（不允许把接口挪到别的分类链）。"""
    _, cat_a, iffs_a = await _seed(session, n=2, category_id=_uid())
    _, cat_b, iffs_b = await _seed(session, n=1, category_id=_uid())
    mixed = [iffs_a[0].id, iffs_a[1].id, iffs_b[0].id]

    with pytest.raises(Exception) as exc:
        await QuoteInterfaceService(session).reorder(cat_a.id, mixed)
    assert exc.value.status_code == 400


async def test_list_all_returns_priority_order(session):
    """list_all 必须按 priority 升序返回，否则拖拽调序后重拉会按 name 弹回。

    对应 ADR-002 §5.3 拖拽调序读路径 — 这是「拖完提示已保存但顺序无变化」的根因回归。
    """
    _, cat, iffs = await _seed(session, n=3)
    # 重排为 [if2, if0, if1]（priority 写作 0/1/2）
    await QuoteInterfaceService(session).reorder(
        cat.id, [iffs[2].id, iffs[0].id, iffs[1].id]
    )
    await session.commit()

    # 列表名按字母序会是 [if0, if1, if2]，与 priority 顺序不同 —— 用于区分两种排序
    all_rows = await QuoteInterfaceService(session).list_all()
    cat_rows = [r for r in all_rows if r.category_id == cat.id]
    assert [r.id for r in cat_rows] == [iffs[2].id, iffs[0].id, iffs[1].id]
    assert [r.priority for r in cat_rows] == [0, 1, 2]


async def test_create_default_priority_append_to_end(session):
    """create 默认 priority = COALESCE(MAX(priority),-1)+1，落该分类末位。"""
    provider, cat, iffs = await _seed(session, n=2)
    new = await QuoteInterfaceService(session).create(
        provider_id=provider.id,
        category_id=cat.id,
        name="new-if",
    )
    await session.commit()
    await session.refresh(new)

    assert new.priority == 2  # max(0,1)+1

    rows = (
        await session.execute(
            select(QuoteInterface)
            .where(QuoteInterface.category_id == cat.id)
            .order_by(QuoteInterface.priority)
        )
    ).scalars().all()
    assert rows[-1].id == new.id  # 末位
