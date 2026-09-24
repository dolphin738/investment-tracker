"""统一入口：解析 sh/sz/bj/hk 前缀 → 港股 → 可转债 → 场内基金 → 指数 → A股/B股/北交所/老三板 → 债券兜底。"""

from __future__ import annotations

import re
from typing import Optional

from app.models.enums import SecurityType
from ._constants import HK, SZ, _ASSET_CLASS_TO_ENUM
from .astock import classify_astock
from .cb_index_bond import _classify_bond, _classify_index, classify_convertible
from .fund import classify
from .parse import _parse_raw

__all__ = ["classify_security", "infer_asset_class"]


def classify_security(raw_code: str, name: str = "") -> dict:
    """统一判定：资产大类 + 交易所 + 细分类型。raw_code 可带 sh/sz/bj/hk 前缀。"""
    raw_code = (raw_code or "").strip()
    name = (name or "").strip()
    ex_hint, code = _parse_raw(raw_code)
    if not re.fullmatch(r"\d{6}", code):
        # 港股：5 位及以下纯数字（大陆证券均为 6 位）
        if ex_hint == HK or (code.isdigit() and len(code) <= 5 and code):
            return {"asset_class": "港股", "exchange": HK, "sub_type": "港股股票"}
        return {"asset_class": "非6位数字代码", "exchange": None, "sub_type": None}
    p = code[:3]
    p1 = code[0]
    # 1) 港股（显式 hk 前缀已由 _parse_raw 提取，或 5 位纯数字兜底）
    if ex_hint == HK or (p1 == "0" and len(code) <= 5):
        return {"asset_class": "港股", "exchange": HK, "sub_type": "港股股票"}
    # 2) 可转债 / 可交债(EB) 优先（前缀 110/113/123/127/128 为可转债；
    #    118/132(沪)/120(深) 为可交债(EB)，属上市债券但非可转债，
    #    此前因 is_cb=False 被丢弃，此处补回 → 映射 BOND）
    cb = classify_convertible(code, name)
    if cb["is_cb"]:
        return {"asset_class": "可转债", "exchange": cb["exchange"], "sub_type": cb["asset_class"]}
    if cb["asset_class"] == "可交债(EB)":
        return {"asset_class": "可交债(EB)", "exchange": cb["exchange"], "sub_type": cb["asset_class"]}
    # 3) 场内基金段：5xxxxx / 15xxxxx / 16xxxxx / 18xxxxx
    if p1 == "5" or p[:2] in ("15", "16", "18"):
        # 深市 150xxx = 分级基金份额（结构化基金，噪音/非投资标的），
        # 由 is_dropped 拦截不入 securities 主数据表；此处先识别为独立类别。
        if p == "150":
            return {"asset_class": "分级基金", "exchange": SZ, "sub_type": "分级基金"}
        f = classify(code, name)
        if f["listed"]:
            return {"asset_class": "场内基金", "exchange": f["exchange"], "sub_type": f["asset_type"]}
        return {"asset_class": "场外基金", "exchange": None, "sub_type": None}
    # 4) 指数（须交易所前缀辅助，解决 000012 同名碰撞：南玻A vs 国债指数）
    idx = _classify_index(code, ex_hint, name)
    if idx:
        return idx
    # 5) A股 / B股 / 北交所 / 老三板
    a = classify_astock(code)
    astock_result = {"asset_class": a["asset_class"], "exchange": a["exchange"], "sub_type": a["board"]}
    # 6) 债券兜底（最末，零回归风险）：仅当 A股 分支判定为「未分类/其他」时，
    #    才尝试改判为债券；已明确分类为 A股/B股/北交所/老三板 的不再改判。
    if a["asset_class"] == "未分类/其他":
        bond = _classify_bond(code, name)
        if bond:
            return bond
    return astock_result


def infer_asset_class(code: str, exchange: Optional[str] = None, name: str = "") -> SecurityType:
    """从代码 + 名称推断资产类别（SecurityType）。

    与 ``classify_security`` 共用同一套规则（单一事实来源）。``name`` 用于提升
    场内/场外基金的区分精度（混合代码段 519/510/560/150 等需名称标记佐证）；
    缺省为空时混合段保守判为场外/未分类。

    - 交易所 HK → HK_STOCK；
    - 场内基金 → ON_EXCHANGE_FUND；场外基金 → OFF_EXCHANGE_FUND；
    - 可转债 → CONVERTIBLE_BOND；指数 → INDEX；
    - 可交债(EB) / 普通债券（国债/公司债/企业债…）→ BOND（路由链最末兜底，零回归风险）；
    - A股（含主板/科创板/创业板/北交所）→ STOCK；B股 → STOCK；
    - 老三板/全国股转 → UNCATEGORIZED（且由 ``is_dropped`` 丢弃，不写入主数据表）。
    """
    res = classify_security(code, name)
    return _ASSET_CLASS_TO_ENUM.get(res["asset_class"], SecurityType.UNCATEGORIZED)
