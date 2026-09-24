"""证券分类自动判断规则 —— 单一事实来源 (single source of truth)。

所有「从代码推断交易所 / 资产类别」的逻辑都集中在此包。其他模块
（持仓 type 推断 ``security.py``、主数据同步 ``market_data_sync.py``、接口测试
代码前缀补全）一律 **import 本包后调用**，禁止在各自文件里重复维护
「前缀 → 交易所 / 代码 → 资产类别」的映射规则。

规则来源：``docs/fund-classification-rules.md``（基于小熊同学 ``/fund/all``、
``/stock/all`` 接口真实数据 + 互联网核实归纳）。本包是其权威代码实现。

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

本包为「纯位移拆分」：逻辑子模块见 ``_constants`` / ``parse`` / ``fund`` /
``astock`` / ``cb_index_bond`` / ``exchange`` / ``unified`` / ``dropped``，
本文件作为门面，重导出全部原有公开符号，保证
``from app.services.classification import X`` 与 ``classification.X`` 两种引用
方式均保持不变（零行为变更）。
"""

from __future__ import annotations

from ._constants import (
    BJ,
    CB_SH_PREFIX,
    CB_SZ_PREFIX,
    DELISTED_FUND_CODES,
    DROP_PREFIX1,
    EXCHANGE_PREFIX,
    HK,
    NAME_MARKET_MARKERS,
    OTC_NAME_MARKERS,
    CURRENCY_NAME_KW,
    INDEX_NAME_KW,
    SH,
    SH_MIXED,
    SH_PURE,
    SZ,
    SZ_MIXED,
    SZ_PURE,
    BOND_CODE_SEG3,
    BOND_NAME_KW,
    BOND_EXCLUDE_KW,
)
from .astock import classify_astock
from .cb_index_bond import _classify_bond, _classify_index, classify_convertible
from .dropped import is_dropped
from .exchange import infer_exchange, infer_exchange_prefix
from .fund import _asset_type, classify
from .parse import _parse_raw
from .unified import classify_security, infer_asset_class

__all__ = [
    # 常量
    "EXCHANGE_PREFIX",
    "SH",
    "SZ",
    "BJ",
    "HK",
    "SH_PURE",
    "SZ_PURE",
    "SH_MIXED",
    "SZ_MIXED",
    "NAME_MARKET_MARKERS",
    "OTC_NAME_MARKERS",
    "CURRENCY_NAME_KW",
    "INDEX_NAME_KW",
    "CB_SH_PREFIX",
    "CB_SZ_PREFIX",
    "BOND_CODE_SEG3",
    "BOND_NAME_KW",
    "BOND_EXCLUDE_KW",
    "DROP_PREFIX1",
    "DELISTED_FUND_CODES",
    # 函数
    "_parse_raw",
    "classify",
    "_asset_type",
    "classify_astock",
    "classify_convertible",
    "_classify_index",
    "_classify_bond",
    "classify_security",
    "infer_exchange",
    "infer_exchange_prefix",
    "infer_asset_class",
    "is_dropped",
]
