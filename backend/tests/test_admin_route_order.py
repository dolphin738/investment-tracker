"""守卫：admin 门面 ``include_router`` 顺序与「静态优先于同段数参数路径」不得静默错位。

背景（S2 拆分复盘 + M4 覆盖缺口）：
``app/modules/admin/router.py`` 已由单文件拆为 **子 Router + 门面** 结构 —— 门面
``router_admin`` 用 ``include_router`` 依次挂载 ``router_quote`` → ``router_category``
→ ``router_master``。拆分后浮现两条**隐性约束**，且在既有测试里**零覆盖**：

**QA 变异实测（M4）**：把门面 ``include_router`` 顺序打乱成 master → category → quote，
生效路由表 diff 出 **111 行**变化（静态路径被参数路径抢匹配的隐患），
**但整仓 pytest 仍 65 passed（GREEN）** —— 即该约束一旦被后人无意破坏，
**没有任何测试会报警**，属典型「静默失效」。

两条被守护的约束：

1. **include 顺序必须 quote → category → master**：Starlette 按注册顺序匹配路由。
   ``/api/admin/quote-providers/interfaces``（静态）与
   ``/api/admin/quote-providers/{provider_id}``（路径参数）**段数相同**，
   静态必须先行，否则会被参数路由以 ``provider_id='interfaces'`` 抢匹配。
2. **静态路径先于同段数参数路径注册**：若有人重排 ``quote_router`` 内部端点顺序，
   同样会静默失效——本守卫按「生效顺序」二次兜底。

实现说明（FastAPI 0.141.1 惰性路由）：
``app.routes`` 与 ``router.routes`` 里并非真实路由，而是 ``_IncludedRouter`` 包装对象；
真实路径在 ``effective_candidates`` 产生的 ``_EffectiveRouteContext``（``.path`` /
``.original_route``）里，且**可嵌套**（门面 → 子 Router），故必须**递归展开**才能拿到
「生效注册顺序」。
"""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any

from app.main import app
from app.modules.admin.category_router import router_category
from app.modules.admin.master_router import router_master
from app.modules.admin.quote_router import router_quote
from app.modules.admin.router import router_admin

# 段数相同、必须静态优先的一对路径（全量生效路径，含父前缀拼接后的结果）。
_STATIC_PATH = "/api/admin/quote-providers/interfaces"
_PARAM_PATH = "/api/admin/quote-providers/{provider_id}"

# 拆出的 3 个子 Router 顺序：quote → category → master。
_EXPECTED_INCLUDE_ORDER = (router_quote, router_category, router_master)
_EXPECTED_ORDER_NAMES = ("router_quote", "router_category", "router_master")

# 现有 26 条 admin 端点（13 + 6 + 7）；钉住「端点不丢失」。
_EXPECTED_ENDPOINT_COUNT = 26

# 管理员路由统一使用响应信封路由类。
_ENVELOPE_ROUTE_NAME = "EnvelopeRoute"


def _resolve(value: Any) -> Any:
    """``effective_*`` 系列既可能是属性也可能是方法，统一取值。"""
    return value() if callable(value) else value


def _is_included(node: Any) -> bool:
    """是否为 include_router 产生的惰性包装节点。"""
    return type(node).__name__ == "_IncludedRouter"


def _find_top_included(target: Any) -> Any:
    """在 ``app.routes`` 中定位由 ``target`` 这座 Router 挂载的顶层惰性节点。

    用 ``include_context.included_router is target`` 身份比对（``app.main``
    ``include_router`` 注册的就是同一对象）。
    """
    for route in app.routes:
        if not _is_included(route):
            continue
        include_context = getattr(route, "include_context", None)
        if include_context is None:
            continue
        if getattr(include_context, "included_router", None) is target:
            return route
    return None


def _effective_leaves(node: Any) -> Iterator[Any]:
    """递归产出 ``_EffectiveRouteContext`` 叶子，顺序即生效注册顺序。

    ``_IncludedRouter`` 会再次递归（门面 → 子 Router 的嵌套），直到拿到带
    ``path`` / ``original_route`` 的真实路由上下文。
    """
    for candidate in _resolve(node.effective_candidates):
        if _is_included(candidate):
            yield from _effective_leaves(candidate)
        else:
            yield candidate


def _admin_leaf_contexts() -> list[Any]:
    """取 ``router_admin`` 全量生效路由上下文（含反空洞断言，空列表即守卫失效）。"""
    top = _find_top_included(router_admin)
    assert top is not None, (
        "未在 app.routes 找到 router_admin 的 _IncludedRouter —— "
        "门面结构或 app.main 挂载方式已变，本守卫失效，请检查 resolve 逻辑"
    )
    leaves = list(_effective_leaves(top))
    # 反空洞：解析机制若失灵（拿到空列表），后续所有「顺序」断言都会假通过。
    assert leaves, "递归解析 admin 生效路由得到空列表 —— resolve 逻辑失效（守卫空洞）"
    return leaves


def test_admin_endpoint_count_is_26() -> None:
    """拆分为子 Router 不得丢失任何端点（13 + 6 + 7 = 26）。"""
    leaves = _admin_leaf_contexts()
    assert len(leaves) == _EXPECTED_ENDPOINT_COUNT, (
        f"router_admin 生效端点数应为 {_EXPECTED_ENDPOINT_COUNT}，实际 {len(leaves)}："
        f"{[getattr(lf, 'path', None) for lf in leaves]}"
    )


def test_include_order_is_quote_category_master() -> None:
    """门面 include_router 顺序必须 quote → category → master（M4 打乱顺序即失效）。"""
    top = _find_top_included(router_admin)
    assert top is not None, "未找到 router_admin 的 _IncludedRouter（守卫失效）"

    children: list[Any] = []
    for candidate in _resolve(top.effective_candidates):
        include_context = getattr(candidate, "include_context", None)
        children.append(
            getattr(include_context, "included_router", None)
            if include_context is not None
            else None
        )

    # 反空洞：必须是 3 个子 Router，否则「顺序」断言会因元素缺失而含义不明。
    assert len(children) == len(_EXPECTED_INCLUDE_ORDER), (
        f"门面应挂载 {len(_EXPECTED_INCLUDE_ORDER)} 个子 Router，实际 {len(children)}"
    )
    labels = {id(r): name for name, r in zip(_EXPECTED_ORDER_NAMES, _EXPECTED_INCLUDE_ORDER)}
    assert children == list(_EXPECTED_INCLUDE_ORDER), (
        "include_router 顺序错误：期望 quote → category → master，实际 "
        f"{[labels.get(id(ch), repr(ch)) for ch in children]}"
        "（顺序错位会让静态路径被同段数参数路径抢匹配，静默 404/422）"
    )


def test_static_path_registered_before_param_path() -> None:
    """静态 ``/quote-providers/interfaces`` 必须排在参数 ``/{provider_id}`` 之前。

    段数相同 → Starlette 按注册顺序匹配，静态必须先行，否则被参数路由抢匹配。
    """
    paths = [getattr(lf, "path", None) for lf in _admin_leaf_contexts()]

    # 反空洞：两条路径都必须真实存在，否则「A 在 B 前」会因两者都没索引而假通过。
    assert _STATIC_PATH in paths, (
        f"静态路径 {_STATIC_PATH!r} 不存在（守卫空洞或端点被改名/删除）"
    )
    assert _PARAM_PATH in paths, (
        f"参数路径 {_PARAM_PATH!r} 不存在（守卫空洞或端点被改名/删除）"
    )

    static_idx = paths.index(_STATIC_PATH)
    param_idx = paths.index(_PARAM_PATH)
    assert static_idx < param_idx, (
        f"注册顺序错误：{_STATIC_PATH!r}(idx={static_idx}) 必须早于 "
        f"{_PARAM_PATH!r}(idx={param_idx})，否则参数路由会以 provider_id='interfaces' 抢匹配"
    )


def test_all_admin_routes_use_envelope_route() -> None:
    """所有 admin 生效路由都必须是 ``EnvelopeRoute``（响应信封不得因拆分退化）。"""
    offenders = [
        getattr(lf, "path", None)
        for lf in _admin_leaf_contexts()
        if type(getattr(lf, "original_route", None)).__name__ != _ENVELOPE_ROUTE_NAME
    ]
    assert offenders == [], (
        f"以下 admin 路由未使用 {_ENVELOPE_ROUTE_NAME}（响应信封会退化）：{offenders}"
    )
