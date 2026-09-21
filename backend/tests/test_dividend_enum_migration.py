"""守护迁移 0031（季度股息抓取链路下线）的枚举重建与反向链完整性（行动项 6 / F1）。

背景（评审 L1 / D1）：0031 的 ``_rebuild_enum`` 用「降级 text → DROP TYPE → CREATE TYPE
→ 列改回枚举」重建 ``JobTaskType``。修复前存在两处缺陷：

1. ``_ENUM_VALUES_ALL``（**downgrade 还原目标**）缺 ``DIVIDEND_SPECIAL_BACKFILL`` →
   继续降级到 0015 时，``0015.downgrade`` 的
   ``CAST('DIVIDEND_SPECIAL_BACKFILL' AS "JobTaskType")`` 会因枚举缺该值而**反向迁移链断链**。
2. 重建前只按 ``name`` 删种子行 → 若存在引用「被删枚举值」的普通任务行，
   ``USING task_type::text::"JobTaskType"`` 转换会失败。

本文件为**纯单元护栏**（不连库）：直接按路径加载迁移模块，核验枚举值与重建 SQL 语义。
真正的「降级到 0015 以下再升回 head」链路由 alembic 往返演练（自验门槛 #4）覆盖。
"""
from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType


def _load_migration_0031() -> ModuleType:
    """按路径加载迁移 0031（``alembic/versions`` 非包，故用 importlib）。"""
    path = (
        Path(__file__).resolve().parents[1]
        / "alembic"
        / "versions"
        / "0031_remove_quarterly_dividend_fetch.py"
    )
    spec = importlib.util.spec_from_file_location("_mig_0031", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_keep_values_is_nine_and_excludes_removed() -> None:
    """``_ENUM_VALUES_KEEP``（upgrade 目标）9 项，不含被下线的两个任务类型。"""
    mig = _load_migration_0031()
    assert len(mig._ENUM_VALUES_KEEP) == 9
    assert "DIVIDEND_QUARTERLY_FETCH" not in mig._ENUM_VALUES_KEEP
    assert "DIVIDEND_SPECIAL_BACKFILL" not in mig._ENUM_VALUES_KEEP


def test_all_values_restores_full_history_eleven() -> None:
    """核心护栏：downgrade 还原目标必须是**全历史 11 值**，含
    ``DIVIDEND_SPECIAL_BACKFILL``（否则反向链在 0015 处断链）。"""
    mig = _load_migration_0031()
    assert len(mig._ENUM_VALUES_ALL) == 11
    assert mig._ENUM_VALUES_ALL == mig._ENUM_VALUES_KEEP + [
        "DIVIDEND_SPECIAL_BACKFILL",
        "DIVIDEND_QUARTERLY_FETCH",
    ]


def test_rebuild_enum_emits_guard_delete_first(monkeypatch) -> None:
    """重建前**先**按目标保留列表删除引用被删枚举值的行（防 USING cast 失败）。"""
    mig = _load_migration_0031()
    calls: list[str] = []
    monkeypatch.setattr(mig.op, "execute", lambda stmt: calls.append(str(stmt)))

    mig._rebuild_enum(mig._ENUM_VALUES_KEEP)

    assert calls, "应至少发出 DELETE / ALTER / DROP / CREATE 语句"
    first = calls[0].upper()
    assert first.startswith("DELETE FROM JOB_CONFIGS")
    assert "NOT IN" in first
    # 目标枚举不含被下线的值
    create = next(c for c in calls if "CREATE TYPE" in c)
    assert "DIVIDEND_QUARTERLY_FETCH" not in create
    assert "DIVIDEND_SPECIAL_BACKFILL" not in create


def test_downgrade_restores_eleven_and_seeds_disabled(monkeypatch) -> None:
    """downgrade：还原 11 值枚举 + 重插种子行且 ``enabled=FALSE``（默认禁用）。"""
    mig = _load_migration_0031()
    calls: list[str] = []
    monkeypatch.setattr(mig.op, "execute", lambda stmt: calls.append(str(stmt)))

    mig.downgrade()

    create = next(c for c in calls if "CREATE TYPE" in c)
    assert "DIVIDEND_SPECIAL_BACKFILL" in create
    assert "DIVIDEND_QUARTERLY_FETCH" in create
    insert = next(c for c in calls if "INSERT INTO job_configs" in c)
    assert "FALSE, '0 2 28-31 3,6,9,12 *'" in insert
