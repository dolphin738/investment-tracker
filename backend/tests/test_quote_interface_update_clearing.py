"""QuoteInterface 局部更新「可清空」语义 — 回归测试。

缺陷：编辑接口弹窗里取消勾选全部「资产类别」后保存无效（用户报「资产类别无法编辑」）。
根因：路由层把全部字段显式传给 svc.update()，未提供的字段以 None 传入；服务层
`if value is not None` 一律跳过 → 「客户端显式传 null 清空」与「未传该字段」
无法区分，置空永远不生效。

修复：路由层改用 body.model_dump(exclude_unset=True) 区分两者；服务层仅对
**可空列**应用显式 None。本测试锁定该语义，防止回归。
"""
from __future__ import annotations

import uuid

import pytest

from app.models.enums import QuoteProviderAccessMethod
from app.models.interface_category import InterfaceCategory
from app.models.quote_interface import QuoteInterface
from app.models.quote_provider import SecuritiesDataProvider
from app.modules.admin.router import QuoteInterfaceUpdate
from app.services.quote_interface import QuoteInterfaceService

pytestmark = pytest.mark.asyncio


def _uid() -> str:
    return str(uuid.uuid4())


async def _seed_interface(session, *, asset_class=None):
    """建 提供方 + 分类 + 1 个接口，返回该接口。"""
    provider = SecuritiesDataProvider(
        id=_uid(),
        name="P",
        access_method=QuoteProviderAccessMethod.HTTPS,
        config={"base_url": "https://x.example.com"},
        enabled=True,
    )
    cat = InterfaceCategory(id=_uid(), label="cat")
    session.add_all([provider, cat])
    await session.flush()
    itf = QuoteInterface(
        id=_uid(),
        provider_id=provider.id,
        category_id=cat.id,
        name="if",
        enabled=True,
        asset_class=asset_class,
    )
    session.add(itf)
    await session.commit()
    return itf


async def test_asset_class_can_be_cleared_by_explicit_null(session):
    """显式传 asset_class=None（取消全选）必须真正置空 —— 本缺陷的核心回归点。"""
    itf = await _seed_interface(session, asset_class=["STOCK", "HK_STOCK"])
    svc = QuoteInterfaceService(session)

    body = QuoteInterfaceUpdate(asset_class=None)
    await svc.update(itf, **body.model_dump(exclude_unset=True))
    await session.commit()
    await session.refresh(itf)

    assert itf.asset_class is None


async def test_asset_class_can_be_set(session):
    """显式传数组应正常写入（修复前即已可用，锁定不被回归破坏）。"""
    itf = await _seed_interface(session, asset_class=None)
    svc = QuoteInterfaceService(session)

    body = QuoteInterfaceUpdate(asset_class=["STOCK"])
    await svc.update(itf, **body.model_dump(exclude_unset=True))
    await session.commit()
    await session.refresh(itf)

    assert itf.asset_class == ["STOCK"]


async def test_omitted_field_keeps_value(session):
    """未传该字段时不得改动原值（exclude_unset 的局部更新语义）。"""
    itf = await _seed_interface(session, asset_class=["STOCK"])
    svc = QuoteInterfaceService(session)

    body = QuoteInterfaceUpdate(description="只改描述")
    await svc.update(itf, **body.model_dump(exclude_unset=True))
    await session.commit()
    await session.refresh(itf)

    assert itf.asset_class == ["STOCK"]
    assert itf.description == "只改描述"


async def test_non_nullable_column_explicit_null_is_skipped(session):
    """NOT NULL 列收到显式 None 应被跳过，避免写入 NULL 触发 IntegrityError。"""
    itf = await _seed_interface(session)
    svc = QuoteInterfaceService(session)

    body = QuoteInterfaceUpdate(name=None)
    await svc.update(itf, **body.model_dump(exclude_unset=True))
    await session.commit()
    await session.refresh(itf)

    assert itf.name == "if"  # 原值保持不变，未被置空
