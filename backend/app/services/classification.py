"""证券分类自动判断规则 —— 单一事实来源 (single source of truth)。

所有「从代码推断交易所 / 资产类别」的逻辑都集中在此模块。其他模块
（持仓 type 推断 ``security.py``、主数据同步 ``market_data_sync.py``、接口测试
代码前缀补全）一律 **import 本模块后调用**，禁止在各自文件里重复维护
「前缀 → 交易所 / 代码 → 资产类别」的映射规则。

规则来源：``docs/fund-classification-rules.md``（基于小熊同学 ``/fund/all``、
``/stock/all`` 接口真实数据 + 互联网核实归纳）。本模块是其权威代码实现。

对外提供的三类判断：

- ``infer_exchange``：从代码推断交易所（大写 ``SH/SZ/BJ/HK``）。
- ``infer_exchange_prefix``：返回小写交易所字母，用于代码前缀自动补全
  （``code_prefix=auto``，腾讯/新浪风格 ``sh600519`` / ``hk00700``）。
- ``infer_asset_class``：从代码 + 名称推断资产类别（``SecurityType`` 枚举）。

富输出统一入口（供需要细分类型的场景调用）：

- ``classify_security``：返回 ``{asset_class, exchange, sub_type}``，
  含 场内基金细分(ETF/LOF/REITs…)、A股板块(沪主板/科创板/创业板/北交所)、
  可转债、指数、老三板/全国股转 等。
- ``is_dropped``：判断某证券是否应**丢弃不写入** ``securities`` 主数据表
  （老三板/全国股转 4xxxxx、北交所旧段 8xxxxx）。
"""

from __future__ import annotations

import re
from typing import Optional

from app.models.enums import SecurityType

# 交易所 → 代码前缀（小写，用于腾讯/新浪风格代码补全）
EXCHANGE_PREFIX: dict[str, str] = {
    "SH": "sh",
    "SZ": "sz",
    "BJ": "bj",
    "HK": "hk",
}

SH = "SH"  # 上交所(沪)
SZ = "SZ"  # 深交所(深)
BJ = "BJ"  # 北交所(京)
HK = "HK"  # 港交所

# —— 纯净场内子段：代码段本身即专属场内，无需名称佐证 ——
SH_PURE = {
    "511", "512", "513", "515", "516", "517", "518",  # ETF(沪)（511 内债券ETF另判；510 含场外债基故降级混合）
    "520", "526",                                       # ETF(沪, 港股通/主题)
    "551",                                               # ETF(沪)
    "561", "562", "563",                                 # ETF(沪, 指数增强/策略)
    "588", "589",                                        # 科创板ETF(沪)
    "501", "502", "505",                                 # LOF/封基(沪)：501=LOF上市段、502=LOF/指数段、505=原封基段，均专属场内
    "508",                                               # 基础设施REITs(沪)
}
SZ_PURE = {
    "158", "159",                                        # ETF(深)（159 内货币ETF另判）
    "160", "161", "162", "163", "164", "165", "166", "167", "168", "169",  # LOF(深)
}
# 注：深市 180/181/182/183/184 段并非纯净：经接口数据核实，1800xx 实为 OTC 基金
# （如 180001 银华优势企业混合、180008 银华货币A），仅 1801xx–1808xx 与 181001 等
# 才是场内 REITs。故不列入 PURE，改由名称标记(REIT/基础设施)或 180+第4位∈1-9 识别。

# —— 混合子段：同段内既有场内也有场外，必须靠名称标记判定 ——
SH_MIXED = {"500", "510", "519", "530", "550", "560", "570", "580", "590"}
SZ_MIXED = {"150", "151"}

# 场内标记：名称命中即判场内（覆盖混合段）
NAME_MARKET_MARKERS = ("ETF", "LOF", "(LOF)", "REIT", "REITs", "基础设施", "封闭")
# 联接基金为场外影子基金，即使出现在场内段也应判场外
OTC_NAME_MARKERS = ("联接",)
# 货币ETF 名称关键词（仅用于 511/159/519 段内细分，不可作全局场内标记，避免误伤场外货币基金）
CURRENCY_NAME_KW = ("货币", "现金", "保证金", "日利", "添益", "快线", "财富宝")

# 指数名称关键词（用于 000xxx/sh000 / 399xxx/sz399 段识别，解决 000012 同名碰撞）
INDEX_NAME_KW = ("指数", "国债", "企债", "公司债", "信用债", "综指", "成指", "债指")

# 可转债代码段（与 A股/基金 不重叠，前缀即权威；名称含"转债"作佐证）
CB_SH_PREFIX = ("110", "113")            # 沪市可转债：110↔600，113↔601/603
CB_SZ_PREFIX = ("123", "127", "128")     # 深市可转债：123↔创业板，127↔主板，128↔原中小板

# 债券现券代码段（沪市为主；与 A股/基金/可转债 段不重叠）。
# 仅在 classify_security 路由链最末、A股 分支判定为「未分类/其他」时兜底改判为债券，
# 故不与其他分类冲突（零回归风险）。来源：上交所《证券代码段分配指南》第4号（2023/2024/2025 修订）。
BOND_CODE_SEG3 = (
    "010", "018", "019", "020",   # 国债 / 政策性银行金融债 / 记账式贴现国债（沪）
    "100", "101", "112", "122", "124",  # 公司债 / 企业债 / 地方债 / 债券回售 / 资产支持证券（沪）
)
# 债券名称关键词（名称通道兜底；须排除可转债与基金关键词，避免误判）
BOND_NAME_KW = ("国债", "地方债", "地方政府债", "企债", "企业债", "公司债",
                "金融债", "短融", "中票", "可交债")
# 排除词：名称含这些则属可转债或基金，不应判为普通债券
BOND_EXCLUDE_KW = ("转债", "转2", "转3", "ETF", "LOF", "债基", "净值")

# 丢弃段：老三板/全国股转(4xxxxx) 与 北交所旧段(8xxxxx) 不写入主数据表
# （B股 900xxx/200xxx 段在 is_dropped 内单独判定，不在此前缀集合中）
DROP_PREFIX1 = ("4", "8")

# 已退市/终止上市基金（精确代码）：这些代码仍落在正常基金段（501/505/161 等），
# 前缀段规则无法区分单只已退市基金，故用精确 code 匹配拦截，避免误伤同段在存基金。
DELISTED_FUND_CODES: frozenset[str] = frozenset({
    "501003",  # 长信先锐债券（已退市）
    "501035",  # 创金合信鼎鑫睿选定开混合（已退市）
    "505888",  # 嘉实元和（已退市）
    "161907",  # 红利ETF联接（已退市）
})


# ============================================================
# 原始代码解析：小熊同学接口代码形如 sh000012 / sz301141 / bj920020 / hk00700，
# 前缀 sh/sz/bj/hk 即权威交易所信号，必须优先采用（可解决 000012 同名碰撞）。
# ============================================================
def _parse_raw(raw_code: str):
    raw = (raw_code or "").strip().lower()
    m = re.fullmatch(r"(sh|sz|bj|hk)(\d+)", raw)
    if m:
        pf, code = m.groups()
        hint = {"sh": SH, "sz": SZ, "bj": BJ, "hk": HK}[pf]
        return hint, code
    return None, raw


# ============================================================
# 一、场内基金：交易所 + 资产类型(上市结构) 判定
# ============================================================
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


# ============================================================
# 二、A股股票：交易所 + 板块 判定（仅看代码前缀，规则稳定）
# ============================================================
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


# ============================================================
# 三、可转债：交易所 判定（代码前缀 + 名称"转债"双重确认）
# ============================================================
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


# ============================================================
# 四、指数识别：上交所/中证指数代码落 sh000xxx，深交所指数落 sz399xxx；
#    这些段与 A股 股票段不重叠，且能解决 000012(南玻A vs 国债指数) 同名碰撞。
# ============================================================
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


# ============================================================
# 三·五、债券兜底识别（仅路由链最末调用，零回归风险）
# ============================================================
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


# ============================================================
# 统一入口：解析 sh/sz/bj/hk 前缀 → 港股 → 可转债 → 场内基金 → 指数 → A股/B股/北交所/老三板 → 债券兜底
# ============================================================
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


# ============================================================
# 对外 API：被 security.py / market_data_sync.py 调用（保持签名稳定）
# ============================================================
def infer_exchange(code: str) -> Optional[str]:
    """从证券代码推断交易所（大写 SH/SZ/BJ/HK），无法识别返回 None。

    规则（按优先级）：

    1. 显式前缀：``sh/sz/bj/hk``（大小写不敏感）→ 对应交易所。
    2. 纯数字：
       - 长度 ≤ 5 位 → HK（港股，如 02318、80016），须**先于** A 股首位规则，
         否则 80016/02318 等港股 5 位码会被 head 规则误归 BJ/SZ。
       - ``920xxx`` → BJ（北交所平移主板股，特判于 ``9→SH`` 之前）。
       - 首位 6/9 → SH；8 → BJ；0/3 → SZ；5 → SH（沪市基金）。
       - 首位 1：``11xxxx`` 沪可转债→SH，其余（``12/13/15/16/18xxxx`` 深市可转债/债券/基金）→SZ。
       - 首位 4 → None（老三板/全国股转系统，无交易所归属）。
    3. 其它（含非数字、无法识别）→ None。
    """
    if not code:
        return None
    c = str(code).strip().lower()
    # 1. 显式前缀
    if c.startswith("sh"):
        return "SH"
    if c.startswith("sz"):
        return "SZ"
    if c.startswith("bj"):
        return "BJ"
    if c.startswith("hk"):
        return "HK"
    # 2. 纯数字
    digits = re.sub(r"\D", "", c)
    if not digits:
        return None
    # 港股：5 位及以下纯数字（大陆证券均为 6 位）
    if len(digits) <= 5:
        return "HK"
    if digits.startswith("920"):
        return "BJ"  # 北交所主板（920xxx）
    # 债券现券段（上交所；与 A股/基金/可转债 段不重叠，实证来源见 docs/fund-classification-rules.md
    # 第 3·5 节）。历史上 0/1 开头的债券段会被下方 head 规则误归 SZ，此处显式归 SH 修正；
    # 仅命中债券专属段（010/018/019/020/100/101/112/122/124），不影响任何已分类证券（零回归）：
    #   600/601/603/605/688/689/000/001/002/003/300/301/302 等 A股段、5/15/16/18 基金段、
    #   110/113/123/127/128 可转债、000xxx/399xxx 指数段均不在 BOND_CODE_SEG3 内。
    if digits[:3] in BOND_CODE_SEG3:
        return "SH"
    head = digits[0]
    if head in ("6", "9"):
        return "SH"  # 上交所
    if head in ("0", "3"):
        return "SZ"  # 深交所
    if head == "8":
        return "BJ"  # 北交所
    if head == "5":
        return "SH"  # 基金（上交所）
    if head == "1":
        # 沪可转债 11xxxx → SH；其余 1 开头（12/13/15/16/18 等深市可转债/债券/基金）→ SZ
        if digits.startswith("11"):
            return "SH"
        return "SZ"
    # 老三板/全国股转（4xxxxx）：无交易所归属
    return None


def infer_exchange_prefix(code: str) -> Optional[str]:
    """返回小写交易所字母（sh/sz/bj/hk），用于代码前缀自动补全（``code_prefix=auto``）。

    仅对 **5 位纯数字（港股）** 与 **6 位纯数字（A股/场内基金）** 补前缀，
    其余位数（如 3/4/7 位、非数字代码）返回 None 不补，避免误加字母。
    """
    digits = re.sub(r"\D", "", code or "")
    if len(digits) == 5:
        return "hk"  # 港股恒为 5 位
    if len(digits) == 6:
        ex = infer_exchange(code)
        return EXCHANGE_PREFIX.get(ex or "", "") or None
    return None


# 资产大类(中文) → SecurityType 枚举 映射
_ASSET_CLASS_TO_ENUM: dict[str, SecurityType] = {
    "可转债": SecurityType.CONVERTIBLE_BOND,
    "可交债(EB)": SecurityType.BOND,        # 118/132(沪)/120(深)，上市债券但非可转债
    "债券": SecurityType.BOND,              # 国债/地方债/公司债/企业债 等普通债券兜底
    "场内基金": SecurityType.ON_EXCHANGE_FUND,
    "场外基金": SecurityType.OFF_EXCHANGE_FUND,
    "指数": SecurityType.INDEX,
    "A股": SecurityType.STOCK,
    "B股": SecurityType.STOCK,
    "港股": SecurityType.HK_STOCK,
    "分级基金": SecurityType.UNCATEGORIZED,  # 深市 150xxx，由 is_dropped 拦截不入库
    "老三板/全国股转": SecurityType.UNCATEGORIZED,
    "未分类/其他": SecurityType.UNCATEGORIZED,
    "非6位数字代码": SecurityType.UNCATEGORIZED,
}


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


def is_dropped(raw_code: str, name: str = "") -> bool:
    """是否应**丢弃（不写入）** ``securities`` 主数据表。

    按 ``fund-classification-rules.md`` 规则，以下类别丢弃（噪音/非投资标的）：

    - 老三板 / 全国股转系统：``4xxxxx``（含 ``400xxx`` 退市A股、``420xxx`` 退市B股）；
    - 北交所旧代码段：``8xxxxx``（精选层平移，与 ``920`` 新段区分，一并丢弃）；
    - 深市分级基金：``sz150xxx``（结构化分级基金份额，一律视为噪音，丢弃不入库）；
    - B股：``900xxx``（沪市B股）、``200xxx``/``201xxx``（深市B股，如 201872 招港B）
      ——B股整体不入主数据表。

    保留：``920xxx``（北交所主板新段）、A股主板/科创板/创业板、场内基金、可转债、
    指数 等。

    说明：``4xxxxx`` 段（含 ``400xxx`` 退市A股、``420xxx`` 退市B股、以及名称含
    「退债」的退市可转债）一律按老三板/全国股转处理，**丢弃不入库**——既不归入
    未分类（UNCATEGORIZED），亦不写入主数据表。
    """
    _, code = _parse_raw(raw_code)
    if not re.fullmatch(r"\d{6}", code):
        return False
    # 已退市基金（精确 code，见 DELISTED_FUND_CODES）：不入 securities 主数据表
    if code in DELISTED_FUND_CODES:
        return True
    # 4xxxxx=老三板/全国股转、8xxxxx=北交所旧段、150xxx=深市分级基金、
    # 900xxx=沪市B股、200xxx/201xxx=深市B股，一律丢弃不入库
    # （名称含「退债」的退市可转债落 4xxxxx 段，同样丢弃，不作例外）
    return (
        code[0] in DROP_PREFIX1
        or code.startswith("150")
        or code.startswith("900")
        or code.startswith(("200", "201"))
    )
