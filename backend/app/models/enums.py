"""业务枚举（对齐 app Prisma 6 个 enum，PG 原生枚举类型名保持一致）。

PG 枚举类型名使用 Prisma 原始标识符（CashFlowType / SecurityType / ...），
新建迁移时按此名创建原生枚举类型。
"""
from __future__ import annotations

import enum


class CashFlowType(str, enum.Enum):
    BUY = "BUY"
    SELL = "SELL"


class SecurityType(str, enum.Enum):
    STOCK = "STOCK"
    FUND = "FUND"
    BOND = "BOND"
    OTHER = "OTHER"
    CASH = "CASH"


class SecuritySide(str, enum.Enum):
    BUY_SEC = "BUY_SEC"
    SELL_SEC = "SELL_SEC"


class SnapshotSource(str, enum.Enum):
    DERIVED = "DERIVED"
    MANUAL = "MANUAL"


class SnapshotValuation(str, enum.Enum):
    EXACT = "EXACT"
    CARRIED_FORWARD = "CARRIED_FORWARD"
    COST_BASED = "COST_BASED"
    MANUAL_INPUT = "MANUAL_INPUT"


class DividendType(str, enum.Enum):
    CASH = "CASH"
    STOCK_DIVIDEND = "STOCK_DIVIDEND"


class ExportType(str, enum.Enum):
    """数据导出类型（§4.2.17）。值即路由/服务层使用的字符串标识。"""

    SECURITIES = "securities"
    SECURITY_TRADES = "securityTrades"
    CASH_FLOWS = "cashFlows"
    CASH_BALANCES = "cashBalances"
    SECURITY_PRICES = "securityPrices"
    ASSET_SNAPSHOTS = "assetSnapshots"
    NAV_SERIES = "navSeries"


class ImportType(str, enum.Enum):
    """数据导入类型（§4.2.17）。值即路由/服务层使用的字符串标识。"""

    SECURITY_TRADES = "securityTrades"
    CASH_FLOWS = "cashFlows"
    ASSET_SNAPSHOTS = "assetSnapshots"


class ImportErrorCode(str, enum.Enum):
    """导入行级错误码（§4.2.17 校验阶段产生）。值即响应错误 dict 的 `code`。"""

    MISSING_REQUIRED_COLUMN = "MISSING_REQUIRED_COLUMN"
    TOO_MANY_ROWS = "TOO_MANY_ROWS"
    INVALID_DATE_FORMAT = "INVALID_DATE_FORMAT"
    INVALID_DECIMAL_PRECISION = "INVALID_DECIMAL_PRECISION"
    INVALID_ENUM_VALUE = "INVALID_ENUM_VALUE"
    SECURITY_NOT_FOUND = "SECURITY_NOT_FOUND"
    DUPLICATE_SNAPSHOT_DATE = "DUPLICATE_SNAPSHOT_DATE"


class QuoteProviderAccessMethod(str, enum.Enum):
    """证券行情数据提供方接入方式（多提供方管理）。"""

    HTTPS = "https"
    SDK = "sdk"
