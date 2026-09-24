"""响应字段配置核心 —— 常量与闭集白名单（单一事实来源，纯数据层）。

本模块只承载 slot 闭集、白名单、分类契约等规则数据，不含逻辑；被
``response_fields`` 包内各子模块共享导入。
"""

from __future__ import annotations

import re

from app.services.response_path import CompiledField

# COMPILED：resolve_fields 结果类型别名（语义标签）
COMPILED = list[CompiledField]

# slot 闭集白名单（仅 5 个，方案 §4.1）——每个 slot 背后必须有代码消费者
SLOT_CODE = "code"          # 证券代码（4 个同步用途均必填）
SLOT_NAME = "name"          # 证券名称（MASTER_LIST）
SLOT_EXCHANGE = "exchange"  # 交易所（MASTER_LIST，缺失按代码前缀推断）
SLOT_PRICE = "price"        # 价格 / 收盘价（QUOTE）
SLOT_DATE = "date"          # 日期（QUOTE 日线，返回时效校验）

SLOT_WHITELIST: tuple[str, ...] = (
    SLOT_CODE, SLOT_NAME, SLOT_EXCHANGE, SLOT_PRICE, SLOT_DATE,
)

SLOT_LABELS: dict[str, str] = {
    SLOT_CODE: "证券代码",
    SLOT_NAME: "证券名称",
    SLOT_EXCHANGE: "交易所",
    SLOT_PRICE: "价格 / 收盘价",
    SLOT_DATE: "日期",
}

# 值类型 / 单位白名单与数值约束（方案 §4 字段结构）
TYPE_WHITELIST: tuple[str, ...] = ("string", "number", "decimal", "date", "bool")
UNIT_WHITELIST: tuple[str, ...] = ("none", "yuan", "wan", "pct")
KEY_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
SCALE_MIN = 0
SCALE_MAX = 8
MAX_SOURCE_SEGMENTS = 5  # source 路径段数上限（信封已解包，深度 1~2 层足够）

# 同步用途分类 id（与 market_data_sync 的 4 个 purpose 常量一致；此处用字面量，
# 避免纯逻辑模块反向依赖 service 层）。
MASTER_LIST_CAT_ID = "1"    # 主数据（证券列表）
QUOTE_CAT_ID = "2"          # 价格 / 日线
DIVIDEND_LIST_CAT_ID = "3"  # 分红列表
NOTICE_CAT_ID = "4"         # 公告扫描

# 分类契约：按 4 个同步用途枚举必填 slot（方案 §4.1 / §6 单一真相）。
# 仅强制**无兜底**的槽（code / price / date）；name / exchange 有兜底故不进必填。
SLOT_CONTRACT: dict[str, frozenset[str]] = {
    MASTER_LIST_CAT_ID: frozenset({SLOT_CODE}),
    QUOTE_CAT_ID: frozenset({SLOT_CODE, SLOT_PRICE, SLOT_DATE}),
    DIVIDEND_LIST_CAT_ID: frozenset({SLOT_CODE}),
    NOTICE_CAT_ID: frozenset({SLOT_CODE}),
}

# --------------------------------------------------------------------------- #
# 历史遗留「隐式真相」常量（F4）：集中于此，供旧列合成时追加尝试。
# 消费点不得再各自硬编码这些列名（P1 护栏 ⑥，见 test_response_fields_guardrail.py）。
_FALLBACK_CODE_FIELD = "代码"   # 东财 stock_fhps_em 代码列（原 dividend_sync._FALLBACK_CODE_FIELD）
_NOTICE_CODE_FIELD = "代码"     # 公告 stock_notice_report 代码列（原 dividend_notice_scan._COL_NOTICE_CODE）

# 中文代码列兜底**仅**适用于分红 / 公告用途接口（F4 的两处隐式真相所在）；
# 主数据 / 行情接口历史上**没有**该兜底，不得引入（否则会掩盖列名错配，见
# test_upsert_masters_warns_on_zero_output_with_rows）。
_CODE_FALLBACK_CATEGORIES = frozenset({DIVIDEND_LIST_CAT_ID, NOTICE_CAT_ID})

# 旧列 → slot 语义映射（合成 / 双写共用）
_LEGACY_SLOT_COLUMNS: dict[str, str] = {
    SLOT_CODE: "resp_code_field",
    SLOT_PRICE: "resp_price_field",
    SLOT_NAME: "resp_name_field",
    SLOT_EXCHANGE: "resp_exchange_field",
}
_SLOT_DEFAULT_TYPE: dict[str, str] = {SLOT_PRICE: "decimal", SLOT_DATE: "date"}
