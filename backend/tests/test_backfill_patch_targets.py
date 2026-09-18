"""守卫：回补 monkeypatch 靶点不得被门面 re-export 而**静默失效**。

背景：``monkeypatch.setattr("app.services.market_daily_price_sync._BACKFILL_*", v)`` /
``monkeypatch.setattr("app.services.market_daily_price_sync.backfill_historical", v)``
只改**门面模块**的命名空间。回补引擎拆分后，``backfill_historical`` 运行期读取的是
``market_price_backfill_engine`` 命名空间里的常量/函数——若在门面里 re-export 这些靶点，
patch 会打空：测试照绿，但被测逻辑读到的是未被 patch 的真值，**逻辑从未被覆盖**（静默失效）。

本守卫把这种「静默」变成守卫期硬失败：

1. 静态：扫描 ``tests/*.py`` 全文，不得出现旧靶点路径子串
   ``market_daily_price_sync._BACKFILL_`` 与 ``market_daily_price_sync.backfill_historical``；
2. 运行期：门面模块**不得**持有 6 个 ``_BACKFILL_*`` 常量、``_BACKFILL_LEASE_WAIT_SECONDS``
   与 ``backfill_historical``；
3. 反空洞：被扫描的测试文件数必须 > 0（否则 glob 写错会让静态守卫永远通过），
   且靶点必须真的存在于其归属模块（engine / lease）——守卫非空洞。
"""
from __future__ import annotations

import pathlib

_TESTS_DIR = pathlib.Path(__file__).resolve().parent

# 归属回补引擎的靶点（6 个限速/熔断常量 + 回补主函数）。
_ENGINE_TARGETS = (
    "_BACKFILL_BURST",
    "_BACKFILL_COOLDOWN_MIN",
    "_BACKFILL_COOLDOWN_MAX",
    "_BACKFILL_BACKOFFS",
    "_BACKFILL_FAILURE_BREAKER",
    "_BACKFILL_FETCH_TIMEOUT",
    "backfill_historical",
)
# 归属租约模块的靶点（决策 5：门面不得出现任何 _BACKFILL_*）。
_LEASE_TARGETS = ("_BACKFILL_LEASE_WAIT_SECONDS",)

# 测试中不得再出现的旧靶点路径前缀（应全部改指 market_price_backfill_engine）。
_FORBIDDEN_SUBSTRINGS = (
    "market_daily_price_sync._BACKFILL_",
    "market_daily_price_sync.backfill_historical",
)


def test_no_legacy_patch_targets_in_tests():
    """静态守卫：测试不得再 patch 门面命名空间下的回补靶点（应全部改指 engine）。"""
    test_files = sorted(_TESTS_DIR.glob("*.py"))
    # 反空洞：glob 写错（目录不存在 / 无文件）时本守卫必须失败，而非永远通过。
    assert len(test_files) > 0, f"未扫描到任何测试文件（dir={_TESTS_DIR}）"

    offenders: list[str] = []
    for path in test_files:
        # 跳过本守卫自身（其源码含被禁子串字面量）。
        if path.resolve() == pathlib.Path(__file__).resolve():
            continue
        text = path.read_text(encoding="utf-8")
        for needle in _FORBIDDEN_SUBSTRINGS:
            if needle in text:
                offenders.append(f"{path.name}: {needle}")
    assert offenders == [], (
        "测试仍引用门面命名空间下的回补 monkeypatch 靶点（须改指 "
        f"market_price_backfill_engine）：{offenders}"
    )


def test_facade_does_not_reexport_patch_targets():
    """运行期守卫：门面模块不得持有任何回补 monkeypatch 靶点（否则 patch 静默失效）。"""
    import app.services.market_daily_price_sync as facade

    present = [
        name
        for name in (*_ENGINE_TARGETS, *_LEASE_TARGETS)
        if hasattr(facade, name)
    ]
    assert present == [], (
        "门面 market_daily_price_sync 不得 re-export 回补靶点，实际仍存在："
        f"{present}（re-export 会让 monkeypatch.setattr 静默失效）"
    )

    # 反向自证（守卫非空洞）：靶点确实存在于其归属模块，否则上面断言会因「本就不存在」而假通过。
    import app.services.market_price_backfill_engine as engine
    import app.services.market_price_backfill_lease as lease

    missing_from_engine = [n for n in _ENGINE_TARGETS if not hasattr(engine, n)]
    missing_from_lease = [n for n in _LEASE_TARGETS if not hasattr(lease, n)]
    assert missing_from_engine == [], f"engine 缺失回补靶点：{missing_from_engine}"
    assert missing_from_lease == [], f"lease 缺失回补靶点：{missing_from_lease}"
