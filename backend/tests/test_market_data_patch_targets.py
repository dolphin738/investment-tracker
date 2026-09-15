"""守卫：行情同步 monkeypatch 靶点不得被门面 re-export 而**静默失效**。

背景：``import app.services.market_data_sync as mds; mds._get_shared_http_client = fake``
只改**门面模块**的命名空间。抓取逻辑拆分后，``_fetch_https_raw`` 运行期调用的是
``market_data_fetch`` 命名空间里的 ``_get_shared_http_client`` —— 若在门面里 re-export
该靶点，patch 会打空：测试照绿，但被测逻辑连的是真 httpx 客户端，**逻辑从未被覆盖**
（静默失效）。

本守卫把这种「静默」变成守卫期硬失败：

1. 静态：扫描 ``tests/*.py`` 全文，不得出现旧靶点路径子串
   ``market_data_sync._get_shared_http_client``（应全部改指 ``market_data_fetch``）；
2. 运行期：门面模块**不得**持有 ``_get_shared_http_client``；
3. 反空洞：被扫描的测试文件数必须 > 0（否则 glob 写错会让静态守卫永远通过），
   且靶点必须真的存在于其归属模块 ``market_data_fetch`` —— 守卫非空洞。
"""
from __future__ import annotations

import pathlib

_TESTS_DIR = pathlib.Path(__file__).resolve().parent

# 归属抓取模块的靶点（模块属性赋值型 patch，门面 re-export 即失效）。
_FETCH_TARGETS = (
    "_get_shared_http_client",
    "_apply_code_prefix",
    "_is_placeholder_param_value",
)

# 测试中不得再出现的旧靶点路径前缀（应全部改指 market_data_fetch）。
_FORBIDDEN_SUBSTRINGS = (
    "market_data_sync._get_shared_http_client",
)


def test_no_legacy_patch_targets_in_tests():
    """静态守卫：测试不得再 patch 门面命名空间下的抓取靶点（应全部改指 fetch）。"""
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
        "测试仍引用门面命名空间下的抓取 monkeypatch 靶点（须改指 "
        f"market_data_fetch）：{offenders}"
    )


def test_facade_does_not_reexport_patch_targets():
    """运行期守卫：门面模块不得持有任何抓取 monkeypatch 靶点（否则 patch 静默失效）。"""
    import app.services.market_data_sync as facade

    present = [name for name in _FETCH_TARGETS if hasattr(facade, name)]
    assert present == [], (
        "门面 market_data_sync 不得 re-export 抓取靶点，实际仍存在："
        f"{present}（re-export 会让 monkeypatch.setattr 静默失效）"
    )

    # 反向自证（守卫非空洞）：靶点确实存在于其归属模块，否则上面断言会因「本就不存在」而假通过。
    import app.services.market_data_fetch as fetch

    missing_from_fetch = [n for n in _FETCH_TARGETS if not hasattr(fetch, n)]
    assert missing_from_fetch == [], f"fetch 缺失抓取靶点：{missing_from_fetch}"
