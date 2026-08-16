"""接口级 频率限制 / 重试 / 超时 落地的单元测试。

验证 market_data_sync._guarded_fetch 与 _parse_rate_limit：
- rate_limit 解析为最小请求间隔（秒）；
- retry_count 控制重试次数，且配置类错误（ValueError）不重试；
- 频率限制按接口 id 做固定间隔节流。
"""
from __future__ import annotations

import asyncio
import time

import pytest
from app.models.quote_interface import QuoteInterface
from app.services.market_data_sync import (
    MarketDataSyncService,
    _RATE_LIMITER,
    _parse_rate_limit,
)

pytestmark = pytest.mark.asyncio


def _make_itf(**kw) -> QuoteInterface:
    """构造最小 QuoteInterface 实例（不落库），仅用于读取字段。"""
    defaults = dict(
        id="if-test",
        provider_id="p",
        name="t",
        enabled=True,
        direction="in",
        resp_code_field="code",
        resp_price_field="price",
    )
    defaults.update(kw)
    return QuoteInterface(**defaults)


async def test_parse_rate_limit() -> None:  # noqa: FFT001  # 模块级 pytestmark 要求 async
    assert _parse_rate_limit(None) is None
    assert _parse_rate_limit("") is None
    assert _parse_rate_limit("garbage") is None
    assert _parse_rate_limit("100/min") == 0.6
    assert _parse_rate_limit("2/sec") == 0.5
    assert _parse_rate_limit("60/hour") == 60.0


async def test_guarded_fetch_retry_then_success(session) -> None:
    svc = MarketDataSyncService(session)
    itf = _make_itf(retry_count=2)
    calls = {"n": 0}

    async def flaky() -> str:
        calls["n"] += 1
        if calls["n"] < 3:
            raise RuntimeError("transient")
        return "ok"

    result = await svc._guarded_fetch(itf, flaky)
    assert result == "ok"
    assert calls["n"] == 3  # 1 初始 + 2 重试


async def test_guarded_fetch_retry_exhausted_raises(session) -> None:
    svc = MarketDataSyncService(session)
    itf = _make_itf(retry_count=1)
    calls = {"n": 0}

    async def always_fail() -> str:
        calls["n"] += 1
        raise RuntimeError("boom")

    try:
        await svc._guarded_fetch(itf, always_fail)
        assert False, "应当抛出异常"
    except RuntimeError:
        pass
    # retry_count=1 -> 最多 2 次（1 初始 + 1 重试）
    assert calls["n"] == 2


async def test_guarded_fetch_valueerror_not_retried(session) -> None:
    svc = MarketDataSyncService(session)
    itf = _make_itf(retry_count=3)
    calls = {"n": 0}

    async def bad_config() -> str:
        calls["n"] += 1
        raise ValueError("config error")

    try:
        await svc._guarded_fetch(itf, bad_config)
        assert False, "应当抛出 ValueError"
    except ValueError:
        pass
    assert calls["n"] == 1  # 配置错误不重试


async def test_rate_limit_throttles(session) -> None:
    svc = MarketDataSyncService(session)
    itf = _make_itf(rate_limit="30/min")  # 间隔 2s
    # 重置该接口限流状态，避免跨测试干扰
    _RATE_LIMITER._next_allowed.pop("if-test", None)
    start = time.monotonic()
    await svc._guarded_fetch(itf, lambda: asyncio.sleep(0))
    await svc._guarded_fetch(itf, lambda: asyncio.sleep(0))
    elapsed = time.monotonic() - start
    # 第二次调用应被节流 ≈ 2s（允许 1s 误差）
    assert elapsed >= 1.0, f"rate limit 未生效, elapsed={elapsed}"
