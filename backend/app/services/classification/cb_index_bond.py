"""三、可转债 / 指数 / 债券兜底 识别（代码段与 A股/基金 不重叠，前缀即权威）。"""

from __future__ import annotations

import re
from typing import Optional

from ._constants import (
    BOND_CODE_SEG3,
    BOND_EXCLUDE_KW,
    BOND_NAME_KW,
    CB_SH_PREFIX,
    CB_SZ_PREFIX,
    INDEX_NAME_KW,
    SH,
    SZ,
)

__all__ = ["classify_convertible", "_classify_index", "_classify_bond"]


def classify_convertible(code: str, name: str = "") -> dict:
    """可转债 交易所 判定。代码段与 A股/基金 不重叠，前缀即权威；名称含'转债'作佐证。"""
    code = (code or "").strip()
    name = (name or "").strip()
    res = {"exchange": None, "asset_class": None, "is_cb": False}
    if not re.fullmatch(r"\d{6}", code):
        res["asset_class"] = "非6位数字代码"
        return res
    p = code[:3]
    if p in CB_SH_PREFIX:
        res.update(exchange=SH, asset_class="可转债", is_cb=True); return res
    if p in CB_SZ_PREFIX:
        res.update(exchange=SZ, asset_class="可转债", is_cb=True); return res
    # 可交债(EB)：132(沪)/120(深) 等同属上市债券但非可转债，列出以区分
    if p in ("118", "132"):
        res.update(exchange=SH, asset_class="可交债(EB)", is_cb=False); return res
    if p == "120":
        res.update(exchange=SZ, asset_class="可交债(EB)", is_cb=False); return res
    return res


def _classify_index(code: str, ex_hint, name: str):
    if re.fullmatch(r"000\d{3}", code):
        # 000xxx 段为上证/中证指数专属段（沪）：带 sh 前缀直接命中；
        # 源数据误带 sz 前缀（如 sz000012 国债指数）时，仅名称含指数关键词才认指数，
        # 避免误伤深市 A股（如 sz000001 平安银行）。
        if ex_hint == SH or (name and any(k in name for k in INDEX_NAME_KW)):
            return {"asset_class": "指数", "exchange": SH, "sub_type": "上交所/中证指数"}
    if re.fullmatch(r"399\d{3}", code):
        # 399xxx 段为深证指数专属段（深），同理防止源误带 sh 前缀
        if ex_hint == SZ or (name and any(k in name for k in INDEX_NAME_KW)):
            return {"asset_class": "指数", "exchange": SZ, "sub_type": "深交所指数"}
    return None


def _classify_bond(code: str, name: str = "") -> Optional[dict]:
    """债券兜底识别（classify_security 路由链最末调用）。

    仅当代码段为债券现券段，或名称含债券关键词（且非可转债/基金）时，判定为「债券」。
    命中返回 ``{asset_class, exchange, sub_type}``，未命中返回 ``None``。

    调用方仅在 A股 分支判定为「未分类/其他」时调用本函数，因此不会与可转债 /
    场内基金 / 指数 / A股 等既有分类冲突（零回归风险）。
    """
    code = (code or "").strip()
    name = (name or "").strip()
    if not re.fullmatch(r"\d{6}", code):
        return None
    seg3 = code[:3]
    # 1) 代码段通道：债券现券专属段（沪市，与 A股/基金/可转债 段不重叠）
    if seg3 in BOND_CODE_SEG3:
        return {"asset_class": "债券", "exchange": SH, "sub_type": "债券"}
    # 2) 名称关键词通道：须含债券关键词，且排除可转债/基金关键词
    if name and any(k in name for k in BOND_NAME_KW):
        if any(x in name for x in BOND_EXCLUDE_KW):
            return None
        return {"asset_class": "债券", "exchange": None, "sub_type": "债券"}
    return None
