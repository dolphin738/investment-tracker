"""MarketDataSyncService._fetch_sdk — akshare 懒导入 + DataFrame 解析。

覆盖（对应 ADR-002 §5 第 5 步 / 任务清单 T05）：
- 模块 import 阶段不触发 akshare 导入（即便未安装 akshare）；
- monkeypatch 注入 mock akshare（返回 DataFrame）→ 解析出 {code: Decimal}；
- 业务空（空 DataFrame / None）→ 返回 {}；
- 未配 sdk_func → 清晰报错。
"""
from __future__ import annotations

import sys
import uuid
from decimal import Decimal
from typing import Any

import pytest

import app.services.market_data_sync as mds
from app.models.enums import QuoteProviderAccessMethod
from app.models.interface_category import InterfaceCategory
from app.models.quote_interface import QuoteInterface
from app.models.quote_provider import SecuritiesDataProvider
from app.services.market_data_sync import MarketDataSyncService

pytestmark = pytest.mark.asyncio


def _uid() -> str:
    return str(uuid.uuid4())


class FakeDataFrame:
    """极简 DataFrame 替身：支持 .empty 与 .iterrows()，每行即 dict。"""

    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows
        self.empty = len(rows) == 0

    def iterrows(self):
        for i, r in enumerate(self._rows):
            yield i, r


class FakeAkShare:
    """mock akshare：stock_zh_a_spot 返回带 code/price 列的 DataFrame。"""

    def stock_zh_a_spot(self, **kwargs: Any) -> FakeDataFrame:
        self.last_kwargs = kwargs  # 记录被透传的参数（含 codes）
        return FakeDataFrame(
            [
                {"code": "600000", "price": "12.34"},
                {"code": "000001", "price": "56.78"},
            ]
        )


async def _seed_sdk_interface(
    session, *, sdk_func: str = "stock_zh_a_spot", params: dict | None = None
) -> QuoteInterface:
    provider = SecuritiesDataProvider(
        id=_uid(),
        name="AKShare",
        access_method=QuoteProviderAccessMethod.SDK,
        config={"sdk_name": "akshare", "sdk_func": sdk_func},
        enabled=True,
    )
    cat = InterfaceCategory(id=_uid(), label="A股行情")
    session.add_all([provider, cat])
    await session.flush()
    itf = QuoteInterface(
        id=_uid(),
        provider_id=provider.id,
        category_id=cat.id,
        name="ak-接口",
        enabled=True,
        priority=1,
        resp_code_field="code",
        resp_price_field="price",
        params=params or {},
    )
    session.add(itf)
    await session.commit()
    return itf


async def test_module_import_does_not_import_akshare():
    """仅导入 app.services.market_data_sync 不应在 import 期触发 akshare 导入。"""
    assert "akshare" not in sys.modules
    # 即便显式 reload，akshare 仍不应被导入（懒导入在函数体内）
    import importlib

    importlib.reload(mds)
    assert "akshare" not in sys.modules


async def test_fetch_sdk_parses_dataframe(session, monkeypatch):
    """mock akshare 返回 DataFrame → 解析出 {code: Decimal}；codes 透传。"""
    itf = await _seed_sdk_interface(session)
    fake = FakeAkShare()
    monkeypatch.setitem(sys.modules, "akshare", fake)

    svc = MarketDataSyncService(session)
    result = await svc._fetch_sdk(itf, ["600000", "000001"])

    assert result == {
        "600000": Decimal("12.34"),
        "000001": Decimal("56.78"),
    }
    # codes 透传进了 akshare 调用参数
    assert fake.last_kwargs.get("codes") == ["600000", "000001"]


async def test_fetch_sdk_empty_returns_empty_dict(session, monkeypatch):
    """业务返回空 DataFrame → 返回 {}（触发向下一接口）。"""
    itf = await _seed_sdk_interface(session)
    fake = FakeAkShare()
    fake.stock_zh_a_spot = lambda **kw: FakeDataFrame([])  # type: ignore[assignment]
    monkeypatch.setitem(sys.modules, "akshare", fake)

    svc = MarketDataSyncService(session)
    assert await svc._fetch_sdk(itf, ["600000"]) == {}


async def test_fetch_sdk_missing_sdk_func_raises(session, monkeypatch):
    """未配 sdk_func → 清晰报错（ValueError）。"""
    itf = await _seed_sdk_interface(session, sdk_func="")
    monkeypatch.setitem(sys.modules, "akshare", FakeAkShare())

    svc = MarketDataSyncService(session)
    with pytest.raises(ValueError):
        await svc._fetch_sdk(itf, ["600000"])
