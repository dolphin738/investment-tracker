"""原始代码解析：小熊同学接口代码形如 sh000012 / sz301141 / bj920020 / hk00700，
前缀 sh/sz/bj/hk 即权威交易所信号，必须优先采用（可解决 000012 同名碰撞）。
"""

from __future__ import annotations

import re

from ._constants import BJ, HK, SH, SZ

__all__ = ["_parse_raw"]


def _parse_raw(raw_code: str):
    raw = (raw_code or "").strip().lower()
    m = re.fullmatch(r"(sh|sz|bj|hk)(\d+)", raw)
    if m:
        pf, code = m.groups()
        hint = {"sh": SH, "sz": SZ, "bj": BJ, "hk": HK}[pf]
        return hint, code
    return None, raw
