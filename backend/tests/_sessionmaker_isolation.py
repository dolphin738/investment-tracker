"""测试隔离：把各 ``app`` 模块在 import 期绑定的 ``AsyncSessionLocal`` 别名统一重绑到测试库 maker。

**问题**：多数服务模块用 ``from app.db.database import AsyncSessionLocal`` 在 import 期绑定
模块级别名；``conftest._engine`` 只重绑 ``app.db.database`` 上的属性名，**别名不会随之更新**。
于是 ``app.services.log.record`` / ``app.services.scheduler._run_job_inner`` 这类「自建会话」
的代码会**静默写开发库**——违反项目硬约束「禁止改动开发库 investment_tracker」。

**方案**：``rebind_sessionmakers`` 扫描 ``sys.modules`` 中全部 ``app`` / ``app.*`` 模块，把任何
「属性存在且 **不等于** 测试 maker」的 ``AsyncSessionLocal`` 别名改指向测试 maker，并返回
``[(module, old_value), ...]`` 供 ``restore_sessionmakers`` 逐条还原。由 ``backend/conftest.py``
的全局 autouse 夹具在 ``_engine`` 之后调用，覆盖**全部**测试文件（不再逐文件抄夹具）。

本模块**不改** ``app.db.database`` 自身属性（它已被 ``_engine`` patch 为测试 maker，
``current is maker`` 会自然跳过），只改其它模块上的别名。
"""
from __future__ import annotations

import sys
from typing import Any

# 应用包名：只处理本项目模块，不碰第三方 / 测试自身。
_APP_PACKAGE = "app"

# 需要重绑的模块属性的名字（各服务模块 `from app.db.database import AsyncSessionLocal` 的落点）。
_ATTR = "AsyncSessionLocal"


def iter_app_modules() -> list[Any]:
    """返回当前已导入的 ``app`` 与 ``app.*`` 模块对象（跳过 ``sys.modules`` 的 ``None`` 占位）。"""
    modules: list[Any] = []
    for name, module in list(sys.modules.items()):
        if module is None:
            continue
        if name == _APP_PACKAGE or name.startswith(_APP_PACKAGE + "."):
            modules.append(module)
    return modules


def rebind_sessionmakers(test_sessionmaker: Any) -> list[tuple[Any, Any]]:
    """把全部 ``app`` 模块上「不等于 ``test_sessionmaker``」的 ``AsyncSessionLocal`` 别名重绑它。

    跳过：没有该属性的模块、以及已指向 ``test_sessionmaker`` 的模块（含被 ``_engine`` patch 过的
    ``app.db.database`` 自身——故**绝不改动核心配置模块**）。返回 ``[(module, old_value), ...]``，
    交由 :func:`restore_sessionmakers` 精确还原。
    """
    changes: list[tuple[Any, Any]] = []
    for module in iter_app_modules():
        current = getattr(module, _ATTR, None)
        if current is None or current is test_sessionmaker:
            continue
        changes.append((module, current))
        setattr(module, _ATTR, test_sessionmaker)
    return changes


def restore_sessionmakers(changes: list[tuple[Any, Any]]) -> None:
    """把 :func:`rebind_sessionmakers` 的改动逐条还原（各模块互不相干，顺序无碍）。"""
    for module, old_value in changes:
        setattr(module, _ATTR, old_value)
