"""一、场内基金：交易所 + 资产类型(上市结构) 判定。"""

from __future__ import annotations

import re

from ._constants import (
    BJ,
    NAME_MARKET_MARKERS,
    OTC_NAME_MARKERS,
    CURRENCY_NAME_KW,
    SH,
    SH_PURE,
    SZ,
    SZ_PURE,
)

__all__ = ["classify", "_asset_type"]


def classify(code: str, name: str = "") -> dict:
    code = (code or "").strip()
    name = (name or "").strip()
    res = {"exchange": None, "asset_type": None, "listed": False, "note": ""}

    if not re.fullmatch(r"\d{6}", code):
        res["note"] = "非6位数字代码"
        return res

    seg3 = code[:3]
    prefix1 = code[0]

    # —— 交易所：仅场内基金段才继续 ——
    if prefix1 == "5":
        res["exchange"] = SH
    elif seg3[:2] in ("15", "16", "18"):
        res["exchange"] = SZ
    elif prefix1 == "8" or prefix1 == "4":
        res["exchange"] = BJ
        res["note"] = "北交所/老三板代码段，非场内基金"
        return res
    else:
        res["note"] = "非场内基金代码段(股票/B股/可转债/场外等)"
        return res

    # —— 是否场内：纯净子段 或 名称含标记 ——
    is_pure = (res["exchange"] == SH and seg3 in SH_PURE) or \
              (res["exchange"] == SZ and seg3 in SZ_PURE)
    has_marker = any(m in name for m in NAME_MARKET_MARKERS)
    is_otc_name = any(m in name for m in OTC_NAME_MARKERS)

    # 特例：名称同时含「联接」与「LOF」（如 160119 500ETF联接LOF）是场内 LOF——
    # 联接基金以 LOF 份额在交易所上市、可场内交易，不受「联接即场外」规则拦截。
    if is_otc_name and "LOF" not in name:
        res["note"] = "名称含联接等场外标记，判为场外基金"
        res["exchange"] = None
        return res

    # 519xxx 特例：该段场内基金仅限场内货币ETF(添富快线/财富宝等)，名称含货币关键词才判场内
    if res["exchange"] == SH and seg3 == "519":
        if any(k in name for k in CURRENCY_NAME_KW):
            res["listed"] = True
            res["asset_type"] = "货币ETF"
            res["note"] = "场内；519xxx 货币ETF 特例"
            return res
        res["note"] = "519xxx 无货币ETF名称标记，判为场外基金"
        res["exchange"] = None
        return res

    listed = is_pure or has_marker
    if not listed:
        res["note"] = f"落在混合子段{seg3}且名称无场内标记，判为场外基金"
        res["exchange"] = None
        return res

    res["listed"] = True

    # —— 资产类型(上市结构) 判定 ——
    asset = _asset_type(code, name, res["exchange"], seg3)
    res["asset_type"] = asset
    res["note"] = f"场内；子段{seg3}"
    return res


def _asset_type(code: str, name: str, exch: str, seg3: str) -> str:
    n = name
    currency = any(k in n for k in CURRENCY_NAME_KW)
    # 基础设施REITs：名称标记(REIT/REITs/基础设施) / 沪 508xxx / 深 180 段第4位∈1-9(1801xx–1808xx)
    if "REIT" in n or "REITs" in n or "基础设施" in n or seg3 == "508" \
       or (seg3 == "180" and code[3] in "123456789"):
        return "REITs"
    # 封闭式基金（500/505 为沪市封基段：500 内 LOF/ETF 名称另判，505 为原封基段）
    if "封闭" in n or "封基" in n \
       or (exch == SH and seg3 in ("500", "505") and "LOF" not in n and "ETF" not in n):
        return "封闭式基金"
    # 货币ETF（沪 511xxx 非债券 / 深 159xxx 货币名 / 519 特例已前置）
    if (seg3 == "511" and "国债" not in n and "转债" not in n) \
       or (seg3 == "159" and currency) or (currency and seg3 in ("511", "159")):
        return "货币ETF"
    # 债券ETF
    if ("国债" in n or "转债" in n or "短融" in n or "信用债" in n or "城投" in n
         or "地债" in n or "债ETF" in n) and "ETF" in n:
        return "债券ETF"
    # 黄金/商品ETF
    if seg3 == "518" or "黄金" in n or ("商品" in n and "ETF" in n) \
       or ("石油" in n and "ETF" in n) or ("豆粕" in n and "ETF" in n) or ("有色" in n and "ETF" in n):
        return "商品ETF"
    # 跨境/港股通 ETF (QDII)
    cross = ("恒生" in n or "纳指" in n or "标普" in n or "日经" in n or "德国" in n
             or "法国" in n or "美股" in n or "港股" in n or "中概" in n or "道琼" in n
             or "东南亚" in n or "日本" in n or "美国" in n or "全球" in n or "互联" in n)
    if (exch == SH and seg3 == "513") or (cross and "ETF" in n):
        return "跨境ETF"
    # 科创板ETF
    if seg3 in ("588", "589") or ("科创" in n and "ETF" in n):
        return "科创板ETF"
    # LOF
    if "LOF" in n or seg3 in ("160", "161", "162", "163", "164", "165", "166", "167", "168", "169", "500", "501", "502"):
        return "LOF"
    # ETF（其余）
    if "ETF" in n or seg3 in ("510", "511", "512", "513", "515", "516", "517", "518",
                              "520", "526", "551", "561", "562", "563", "588", "589",
                              "158", "159"):
        return "ETF"
    # 兜底：场内但无法细分
    return "上市基金(其他)"
