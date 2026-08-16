"""证券分类自动判断规则 —— 单一事实来源 (single source of truth)。

所有「从代码推断交易所 / 资产类别」的逻辑都集中在此模块。其他模块
（持仓 type 推断 ``security.py``、主数据同步 ``market_data_sync.py``、接口测试
代码前缀补全）一律 **import 本模块后调用**，禁止在各自文件里重复维护
「前缀 → 交易所 / 代码 → 资产类别」的映射规则。

收敛到本模块的三类判断：

- ``infer_exchange``：从代码推断交易所（大写 ``SH/SZ/BJ/HK``）。
- ``infer_exchange_prefix``：返回小写交易所字母，用于代码前缀自动补全
  （``code_prefix=auto``，腾讯/新浪风格 ``sh600519`` / ``hk00700``）。
- ``infer_asset_class``：从代码 + 交易所推断资产类别（``SecurityType``）。
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


def infer_exchange(code: str) -> Optional[str]:
    """从证券代码推断交易所（大写 SH/SZ/BJ/HK），无法识别返回 None。

    规则（按优先级）：

    1. 显式前缀：``sh/sz/bj/hk``（大小写不敏感）→ 对应交易所。
    2. 纯数字：
       - 长度 ≤ 5 位 → HK（港股，如 02318、80016），须**先于** A 股首位规则，
         否则 80016/02318 等港股 5 位码会被 head 规则误归 BJ/SZ。
       - ``920xxx`` → BJ（北交所平移主板股，特判于 ``9→SH`` 之前）。
       - 首位 6/9 → SH；8/4 → BJ；0/3 → SZ；5 → SH（沪市基金）。
       - 首位 1：``11xxxx`` 沪可转债→SH，其余（``12/13/15/16/18xxxx`` 深市可转债/债券/基金）→SZ。
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
    head = digits[0]
    if head in ("6", "9"):
        return "SH"  # 上交所
    if head in ("0", "3"):
        return "SZ"  # 深交所
    if head in ("8", "4"):
        return "BJ"  # 北交所
    if head == "5":
        return "SH"  # 基金（上交所）
    if head == "1":
        # 沪可转债 11xxxx → SH；其余 1 开头（12/13/15/16/18 等深市可转债/债券/基金）→ SZ
        if digits.startswith("11"):
            return "SH"
        return "SZ"


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


def infer_asset_class(code: str, exchange: Optional[str] = None) -> SecurityType:
    """从代码 + 交易所推断资产类别（SecurityType）。

    与 ``infer_exchange`` 共用同一套前缀 / 数字规则：

    - 显式前缀 sh/sz/bj/hk 优先决定 exchange；
    - 交易所 HK → HK_STOCK；
    - 5xxxxx / 15xxxxx / 16xxxxx / 501 / 502 → 场内基金（ON_EXCHANGE_FUND）；
    - 11xxxx / 12xxxx → 可转债（CONVERTIBLE_BOND）；
    - 399xxx → 指数；000xxx 且上交所（SH）→ 指数；
    - 6/9/0/3/8/4 开头 A 股 → 股票（STOCK）；
    - 其余 → 未分类（UNCATEGORIZED）。
    """
    if not code:
        return SecurityType.UNCATEGORIZED
    c = str(code).strip().lower()
    # 剥离交易所前缀（sh/sz/bj/hk），并据此确认交易所
    exch = (exchange or "").upper()
    if c.startswith(("sh", "sz", "bj", "hk")):
        exch = c[:2].upper()
        c = c[2:]
    if not c:
        return SecurityType.UNCATEGORIZED
    # 港股（交易所识别结果驱动）
    if exch == "HK":
        return SecurityType.HK_STOCK
    # 场内基金（原 ETF/LOF 合并）：沪 5xxxxx、深 15xxxx（ETF）/ 深 16xxxx、沪 501/502（LOF）
    if c.startswith(("5", "15", "16", "501", "502")):
        return SecurityType.ON_EXCHANGE_FUND
    # 可转债：沪 11xxxx、深 12xxxx
    if c.startswith(("11", "12")):
        return SecurityType.CONVERTIBLE_BOND
    # 指数：深 399xxx；000xxx 且为上交所 → 指数（避免误判深市股票）
    if c.startswith("399"):
        return SecurityType.INDEX
    if c.startswith("000") and exch == "SH":
        return SecurityType.INDEX
    # A 股股票：明确属于 A股 的数字前缀
    if c[0] in ("6", "9", "0", "3", "8", "4"):
        return SecurityType.STOCK
    # 其余：代码无法可靠区分具体类别（如场外基金），落未分类兜底
    return SecurityType.UNCATEGORIZED
