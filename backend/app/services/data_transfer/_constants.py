"""数据导入导出服务 —— 常量与全局配置（单一事实来源，纯数据层）。"""

from __future__ import annotations

from app.core.config import get_settings
from app.models.enums import ExportType, ImportType
from app.models.enums import CashFlowType, SecuritySide

MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_ROWS = 10000
TOKEN_TTL_MIN = 10
ALLOWED_EXT = {".csv", ".xlsx", ".xls"}

EXPORT_TYPES = {e.value for e in ExportType}
IMPORT_TYPES = {e.value for e in ImportType}

# 导入字段规格：字段 -> 类型（date/decimal/enum/security/text）
_FIELD_KIND = {
    "securityTrades": {
        "date": "date",
        "securityCode": "security",
        "side": "enum",
        "quantity": "decimal",
        "costPrice": "decimal",
        "feeTotal": "decimal",
        "note": "text",
    },
    "cashFlows": {
        "date": "date",
        "type": "enum",
        "amount": "decimal",
        "note": "text",
    },
    "assetSnapshots": {
        "date": "date",
        "totalAsset": "decimal",
        "marketValue": "decimal",
        "cashBalance": "decimal",
        "note": "text",
    },
}
_REQUIRED = {
    "securityTrades": ["date", "securityCode", "side", "quantity", "costPrice"],
    "cashFlows": ["date", "type", "amount"],
    "assetSnapshots": ["date", "totalAsset"],
}
_ENUM_VALUES = {
    "side": {x.value for x in SecuritySide},
    "type": {x.value for x in CashFlowType},
}

# 模块级全局配置（make_token / decode_token 用）
settings = get_settings()
