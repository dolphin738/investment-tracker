"""全局测试隔离：模块级 ``AsyncSessionLocal`` 别名的重绑 / 还原（**非空洞**守卫）。

守护硬约束「禁止测试写开发库」：``backend/conftest.py`` 的全局 autouse 夹具
``_isolate_module_sessionmakers`` 必须真的把 ``app.services.log`` / ``app.services.scheduler``
等模块级别名重绑到测试库 maker。本文件既验证**全局夹具的实际发现结果非空**（防「扫描逻辑
写错 → 一个都没重绑，但套件照样绿」这种假通过），也直接单测 helper 的重绑 / 还原语义。
"""
from __future__ import annotations

import pytest

import app.db.database as dbmod
from tests._sessionmaker_isolation import rebind_sessionmakers, restore_sessionmakers

pytestmark = pytest.mark.asyncio

# 任务明确要求覆盖的两个关键泄漏模块（自建会话的落库路径）。
_REQUIRED = {"app.services.log", "app.services.scheduler"}


def _module_names(changes) -> set[str]:
    return {getattr(m, "__name__", repr(m)) for m, _ in changes}


async def test_global_fixture_rebinds_module_aliases(
    _isolate_module_sessionmakers, _engine
):
    """全局 autouse 夹具的发现结果**非空**，且覆盖关键泄漏模块；重绑后指向测试 maker。"""
    changes = _isolate_module_sessionmakers
    assert changes, "全局重绑夹具必须至少重绑若干模块，否则隔离形同虚设"
    bound = _module_names(changes)
    assert _REQUIRED <= bound, f"关键模块未被重绑：{_REQUIRED - bound}"

    maker = dbmod.AsyncSessionLocal
    import app.services.log as log_mod
    import app.services.scheduler as scheduler_mod

    assert log_mod.AsyncSessionLocal is maker
    assert scheduler_mod.AsyncSessionLocal is maker


async def test_rebind_and_restore_helper_semantics(_engine):
    """helper 直接单测：重绑「不等于 maker」的别名；还原后回到原值；不误改核心模块。"""
    import app.services.log as log_mod
    import app.services.scheduler as scheduler_mod

    maker = dbmod.AsyncSessionLocal
    original_log, original_sched = log_mod.AsyncSessionLocal, scheduler_mod.AsyncSessionLocal
    # 用哨兵模拟「未重绑」的旧值（全局夹具此时已把它们指到 maker，故先改成哨兵）。
    sentinel = object()
    log_mod.AsyncSessionLocal = sentinel
    scheduler_mod.AsyncSessionLocal = sentinel
    try:
        changes = rebind_sessionmakers(maker)
        assert _REQUIRED <= _module_names(changes)
        assert log_mod.AsyncSessionLocal is maker
        assert scheduler_mod.AsyncSessionLocal is maker
        # 绝不误改已指向 maker 的核心模块（app.db.database 自身）。
        assert all(old is not maker for _, old in changes)

        restore_sessionmakers(changes)
        assert log_mod.AsyncSessionLocal is sentinel
        assert scheduler_mod.AsyncSessionLocal is sentinel
    finally:
        log_mod.AsyncSessionLocal = original_log
        scheduler_mod.AsyncSessionLocal = original_sched
