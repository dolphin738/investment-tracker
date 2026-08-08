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
