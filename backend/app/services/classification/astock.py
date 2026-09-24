"""二、A股股票：交易所 + 板块 判定（仅看代码前缀，规则稳定）。"""

from __future__ import annotations

import re

from ._constants import BJ, SH, SZ

__all__ = ["classify_astock"]


def classify_astock(code: str) -> dict:
    """A股股票的 交易所 + 板块 判定。代码前缀即包含板块信息，无需名称。

    注：北交所 = 920xxx(新段) + 8xxxxx(精选层平移)；4xxxxx 属全国股转/老三板，非北交所。
    """
    code = (code or "").strip()
    res = {"exchange": None, "board": None, "asset_class": None}
    if not re.fullmatch(r"\d{6}", code):
        res["asset_class"] = "非6位数字代码"
        return res
    p = code[:3]
    p1 = code[0]
    # 上交所
    if p in ("600", "601", "603", "605"):
        res.update(exchange=SH, board="沪市主板", asset_class="A股"); return res
    if p == "688":
        res.update(exchange=SH, board="科创板", asset_class="A股"); return res
    if p == "689":
        res.update(exchange=SH, board="科创板(CDR)", asset_class="A股"); return res
    # 深交所
    if p in ("000", "001"):
        res.update(exchange=SZ, board="深市主板", asset_class="A股"); return res
    if p in ("002", "003"):
        res.update(exchange=SZ, board="深市主板(原中小板)", asset_class="A股"); return res
    if p in ("300", "301", "302"):
        res.update(exchange=SZ, board="创业板", asset_class="A股"); return res
    # 北交所/新三板（920 新段；8xxxxx 精选层平移/挂牌，属北交所体系）
    if p == "920" or p1 == "8":
        res.update(exchange=BJ, board="北交所/新三板", asset_class="A股"); return res
    # 老三板 / 全国股转系统（4xxxxx，非北交所！）
    #   400xxx=退市A股，420xxx=退市B股，其余=新三板/老三板（与北交所代码段易混，须单列）
    if p1 == "4":
        if p == "400":
            res.update(exchange=None, board="老三板(退市A股)", asset_class="老三板/全国股转"); return res
        if p == "420":
            res.update(exchange=None, board="老三板(退市B股)", asset_class="老三板/全国股转"); return res
        res.update(exchange=None, board="新三板/老三板(全国股转)", asset_class="老三板/全国股转"); return res
    # B股（非 A股）
    if p == "900":
        res.update(exchange=SH, board="沪市B股", asset_class="B股"); return res
    if p == "200":
        res.update(exchange=SZ, board="深市B股", asset_class="B股"); return res
    res["asset_class"] = "未分类/其他"
    return res
