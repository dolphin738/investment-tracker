"""模型聚合导入 —— 必须在此处 import 所有模型模块，确保它们注册到 Base.metadata。

导入顺序无关（关系使用字符串 forward ref），但必须全部 import，否则建表会漏表。
"""
from app.models.calc import DailyNav, DailyXirr
from app.models.cashflow import CashBalance, CashFlow
from app.models.dividend import DividendRecord
from app.models.enums import (
    CashFlowType,
    DividendType,
    SecuritySide,
    SecurityType,
    SnapshotSource,
    SnapshotValuation,
)
from app.models.portfolio import Portfolio
from app.models.security import Security, SecurityPrice, SecurityTrade
from app.models.snapshot import AssetSnapshot
from app.models.system_config import SystemConfig
from app.models.user import User, UserPreference

__all__ = [
    "User",
    "UserPreference",
    "Portfolio",
    "CashFlow",
    "CashBalance",
    "Security",
    "SecurityTrade",
    "SecurityPrice",
    "AssetSnapshot",
    "SystemConfig",
    "DailyNav",
    "DailyXirr",
    "DividendRecord",
    "CashFlowType",
    "SecurityType",
    "SecuritySide",
    "SnapshotSource",
    "SnapshotValuation",
    "DividendType",
]
