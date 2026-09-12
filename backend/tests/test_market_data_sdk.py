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
    """仅导入 app.services.market_data_sync 不应在 import 期触发 akshare 导入。

    注意：不做 importlib.reload —— reload 会用新类对象覆盖 sys.modules 里的
    MarketDataSyncService，造成「类身份分裂」：本文件与路由层各自绑定的类不是同一对象，
    monkeypatch 打在旧类上、路由实例化新类而失效（表现为接口测试真发网络请求）。
    懒导入保证 akshare 仅在 _fetch_sdk 函数体内 import，模块加载期零副作用。

    **为何改为子进程断言**：原实现直接查本进程的 ``sys.modules``，但同进程内其它用例
    （日线任务链路 → ``update_stale_flags`` → ``refresh_trade_calendar``）会真实
    ``import akshare`` 并把 ``'akshare'`` 永久留在 sys.modules，造成本用例
    **随执行顺序随机失败**（单独跑通过、全量跑失败）。子进程隔离后，断言的才是
    真正的「import 期副作用」，与执行顺序无关。
    """
    import subprocess
    from pathlib import Path

    code = (
        "import sys; import app.services.market_data_sync; "
        "sys.exit(0 if 'akshare' not in sys.modules else 1)"
    )
    proc = subprocess.run(  # noqa: S603 固定 argv、无 shell
        [sys.executable, "-c", code],
        cwd=str(Path(__file__).resolve().parents[1]),
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, (
        "导入 app.services.market_data_sync 触发了 akshare 导入（懒导入被破坏）\n"
        f"stdout: {proc.stdout}\nstderr: {proc.stderr[-800:]}"
    )


async def test_fetch_sdk_parses_dataframe(session, monkeypatch):
    """mock akshare 返回 DataFrame → 解析出 {code: Decimal}；codes 透传。"""
    itf = await _seed_sdk_interface(session)
    fake = FakeAkShare()
    monkeypatch.setitem(sys.modules, "akshare", fake)

    svc = MarketDataSyncService(session)
    result = await svc._fetch_sdk(itf, ["600000", "000001"])

    # 价格 code 同样规范为「交易所前缀 + 数字」（600000→SH，000001→SZ）
    assert result == {
        "sh600000": Decimal("12.34"),
        "sz000001": Decimal("56.78"),
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
    """未配 sdk_func（接口 endpoint 与 provider.config 均缺失）→ 清晰报错（ValueError）。"""
    itf = await _seed_sdk_interface(session, sdk_func="")
    monkeypatch.setitem(sys.modules, "akshare", FakeAkShare())

    svc = MarketDataSyncService(session)
    with pytest.raises(ValueError):
        await svc._fetch_sdk(itf, ["600000"])


async def test_fetch_sdk_uses_interface_endpoint_as_func_name(session, monkeypatch):
    """UI 约定：SDK 顶层函数名取自接口 endpoint（provider.config.sdk_func 仅作旧配置回退）。"""
    itf = await _seed_sdk_interface(session, sdk_func="")
    itf.endpoint = "stock_zh_a_spot"  # 接口「调用路径」填 akshare 函数名
    await session.commit()
    fake = FakeAkShare()
    monkeypatch.setitem(sys.modules, "akshare", fake)

    svc = MarketDataSyncService(session)
    result = await svc._fetch_sdk(itf, ["600000"])
    assert result == {
        "sh600000": Decimal("12.34"),
        "sz000001": Decimal("56.78"),
    }
    assert fake.last_kwargs.get("codes") == ["600000"]


# ───────────────── SDK 拍平：MultiIndex 列显式拒绝（方案 §8 边界 4 / D6） ─────────────────
class _FakePandasDF:
    """含 to_dict("records") 的 DataFrame 替身（走 _flatten_dataframe_records 分支）。"""

    def __init__(self, records: list[dict]) -> None:
        self._records = records
        self.empty = not records

    def to_dict(self, orient: str = "records"):
        assert orient == "records"
        return list(self._records)


async def test_flatten_records_rejects_multiindex_columns() -> None:
    """MultiIndex 列（tuple key）→ 抛可读中文异常，不静默展平、不透传到 json.dumps。"""
    from app.services.market_data_sync import _flatten_dataframe_records

    df = _FakePandasDF([{("代码", "二级"): "600000", "price": "12.34"}])
    with pytest.raises(ValueError, match="MultiIndex"):
        _flatten_dataframe_records(df)


async def test_flatten_records_accepts_scalar_columns() -> None:
    """非 MultiIndex（标量列名）场景零行为影响。"""
    from app.services.market_data_sync import _flatten_dataframe_records

    df = _FakePandasDF([{"code": "600000", "price": "12.34"}])
    assert _flatten_dataframe_records(df) == [{"code": "600000", "price": "12.34"}]
