"""登录失败限速（REP-010）— 进程内滑动窗口限速器。

按 (客户端 IP, 邮箱) 维度计数失败登录；达上限返回 True（应拒绝）。
无需 Redis，适合单实例部署；多实例水平扩展时需替换为共享存储（如 Redis）。
"""
from __future__ import annotations

import time
from collections import defaultdict


_FAILURES: dict[tuple[str, str], list[float]] = defaultdict(list)


def _prune(records: list[float], now: float, window: int) -> list[float]:
    return [t for t in records if now - t < window]


def is_limited(ip: str, email: str, limit: int, window: int) -> bool:
    """该 (ip, email) 在窗口内失败次数是否已达上限。limit<=0 视为关闭。"""
    if limit <= 0:
        return False
    now = time.monotonic()
    key = (ip, email.lower())
    recs = _prune(_FAILURES[key], now, window)
    _FAILURES[key] = recs
    return len(recs) >= limit


def record_failure(ip: str, email: str) -> None:
    _FAILURES[(ip, email.lower())].append(time.monotonic())


def reset(ip: str, email: str) -> None:
    _FAILURES.pop((ip, email.lower()), None)


def reset_all() -> None:
    """清空全部限速状态（测试用）。"""
    _FAILURES.clear()
