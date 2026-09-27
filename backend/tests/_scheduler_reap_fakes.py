"""孤儿 RUNNING 回收测试的共用测试替身（test doubles）。

从 ``tests/test_scheduler_orphan_reap_edge.py`` 抽壳而来：两个替身类与被测用例
无耦合，且该用例文件已逼近「单文件 ≤ 400 行」约定上限，故按 ``tests/_sessionmaker_isolation.py``
同款惯例落到本模块（测试辅助件不进用例文件）。

**纯搬运、零行为变更**：类体逐字保持原样，仅供 ``test_scheduler_orphan_reap_edge.py``
导入使用；``_frozen_clock`` 上下文管理器留在用例文件内（它要 monkeypatch 被测模块，
归属用例更清晰）。
"""
from __future__ import annotations

from datetime import datetime


class _FrozenDateTime(datetime):
    """``reaper`` 的 datetime 替身：``now()`` 返回注入时刻，使宽限期边界可精确判定。"""

    _frozen: datetime | None = None

    @classmethod
    def now(cls, tz=None):  # type: ignore[override]
        assert cls._frozen is not None, "未冻结时间"
        return cls._frozen if tz is None else cls._frozen.astimezone(tz)


class _ExplodingSession:
    """代理真实会话，但 ``commit`` 抛错（模拟提交期故障）。"""

    def __init__(self, real):
        self._real = real

    async def __aenter__(self):
        await self._real.__aenter__()
        return self

    async def __aexit__(self, *exc):
        return await self._real.__aexit__(*exc)

    def execute(self, *a, **k):
        return self._real.execute(*a, **k)

    async def commit(self):
        raise RuntimeError("commit boom")
