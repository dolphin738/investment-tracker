"""登录失败限速（REP-010）— 进程内滑动窗口限速器。

按 (客户端 IP, 邮箱) 维度计数失败登录；达上限返回 True（应拒绝）。
无需 Redis，适合单实例部署；多实例水平扩展时需替换为共享存储（如 Redis）。
"""
from __future__ import annotations

import time
from collections import OrderedDict

# 追踪的 (ip, email) 键上限：防攻击者用海量假邮箱把字典撑爆（内存 DoS）。
# 超限时先清过期键，仍超限则淘汰最旧插入的键（OrderedDict）。
_MAX_TRACKED_KEYS = 10_000

_FAILURES: OrderedDict[tuple[str, str], list[float]] = OrderedDict()


def _prune(records: list[float], now: float, window: int) -> list[float]:
    return [t for t in records if now - t < window]


def _evict_over_limit(now: float, window: int) -> None:
    """键数超上限时：先删全部已过期键，仍超限再按插入序淘汰最旧键。"""
    if len(_FAILURES) <= _MAX_TRACKED_KEYS:
        return
    for key in list(_FAILURES.keys()):
        if len(_FAILURES) <= _MAX_TRACKED_KEYS:
            break
        recs = _prune(_FAILURES[key], now, window)
        if recs:
            _FAILURES[key] = recs
        else:
            _FAILURES.pop(key, None)
    while len(_FAILURES) > _MAX_TRACKED_KEYS:
        _FAILURES.popitem(last=False)


def is_limited(ip: str, email: str, limit: int, window: int) -> bool:
    """该 (ip, email) 在窗口内失败次数是否已达上限。limit<=0 视为关闭。"""
    if limit <= 0:
        return False
    now = time.monotonic()
    key = (ip, email.lower())
    recs = _prune(_FAILURES.get(key, []), now, window)
    if recs:
        _FAILURES[key] = recs
        _FAILURES.move_to_end(key)
    return len(recs) >= limit


def record_failure(ip: str, email: str) -> None:
    now = time.monotonic()
    key = (ip, email.lower())
    recs = _prune(_FAILURES.get(key, []), now, 10_800)
    recs.append(now)
    _FAILURES[key] = recs
    _FAILURES.move_to_end(key)
    _evict_over_limit(now, 10_800)


def reset(ip: str, email: str) -> None:
    _FAILURES.pop((ip, email.lower()), None)


def reset_all() -> None:
    """清空全部限速状态（测试用）。"""
    _FAILURES.clear()
