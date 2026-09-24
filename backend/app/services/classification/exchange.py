"""对外 API：交易所推断（被 security.py / market_data_sync.py / market_data_params.py 调用）。"""

from __future__ import annotations

import re
from typing import Optional

from ._constants import BOND_CODE_SEG3, EXCHANGE_PREFIX

__all__ = ["infer_exchange", "infer_exchange_prefix"]


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
