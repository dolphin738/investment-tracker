"""管理员路由门面 —— 三个子 Router 组装（原 917 行单文件按职责拆分，架构治理 §4）。

端点实现已按职责迁出，本文件只做**组装**与**兼容 re-export**：

- ``quote_router``（``router_quote``）：提供方 / 提供方下接口 / 批量同步（13 端点）；
- ``category_router``（``router_category``）：站内信通知 / 接口分类（6 端点）；
- ``master_router``（``router_master``）：主数据浏览统计删除同步 + 字段 schema + 试调预览（7 端点）。

**构造要点（实测 FastAPI 0.141.1）**：

1. 子 Router 均自带 ``prefix="/api/admin"`` 与 ``route_class=EnvelopeRoute``。
   ``include_router`` **会**把父 Router 的 ``prefix`` 再前置一次，故门面**不得**再带
   ``prefix``（否则路径变成 ``/api/admin/api/admin/...``，全部 404）；而 ``route_class``
   **不会**从父 Router 继承，只能由子 Router 自带 —— 丢了它响应信封全变。
2. ``include_router`` **顺序必须保序**：quote → category → master。
   因为 ``/quote-providers/interfaces``（静态）与 ``/quote-providers/{provider_id}``
   （路径参数）**段数相同**，Starlette 按注册顺序匹配，静态必须先行。
3. 各子 Router 内部端点相对顺序照搬原文（见各子模块）。

``router_admin`` 由 ``app.modules.admin`` 与 ``app.main`` 引用，必须保留在本模块；
全部请求/响应模型在此 re-export，既有
``from app.modules.admin.router import QuoteInterfaceUpdate`` 等导入点零改动。
"""
from __future__ import annotations

from fastapi import APIRouter

from app.core.envelope import EnvelopeRoute
from app.modules.admin.category_router import router_category
from app.modules.admin.master_router import router_master
from app.modules.admin.quote_router import router_quote

# ── 兼容 re-export（原 router.py 的模块级 schema / 校验函数；均非 monkeypatch 靶点） ──
from app.modules.admin.schemas import (
    InterfaceCategoryCreate as InterfaceCategoryCreate,
    InterfaceCategoryOut as InterfaceCategoryOut,
    InterfaceCategoryUpdate as InterfaceCategoryUpdate,
    InterfacePreviewRequest as InterfacePreviewRequest,
    InterfaceTestRequest as InterfaceTestRequest,
    NotificationOut as NotificationOut,
    QuoteInterfaceCreate as QuoteInterfaceCreate,
    QuoteInterfaceOut as QuoteInterfaceOut,
    QuoteInterfaceReorder as QuoteInterfaceReorder,
    QuoteInterfaceUpdate as QuoteInterfaceUpdate,
    QuoteProviderCreate as QuoteProviderCreate,
    QuoteProviderOut as QuoteProviderOut,
    QuoteProviderUpdate as QuoteProviderUpdate,
    SecurityMasterDeleteBody as SecurityMasterDeleteBody,
    _check_config as _check_config,
)

# 门面**不得**带 prefix（会与子 Router 的 prefix 叠加）；也不带 tags（include_router
# 会把父 Router 的 tags 合并进子路由 → 出现重复 tag）；route_class 仅子 Router 生效。
router_admin = APIRouter(route_class=EnvelopeRoute)
router_admin.include_router(router_quote)
router_admin.include_router(router_category)
router_admin.include_router(router_master)
