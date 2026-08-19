"""模型聚合导入 —— 必须在此处 import 所有模型模块，确保它们注册到 Base.metadata。

导入顺序无关（关系使用字符串 forward ref），但必须全部 import，否则建表会漏表。
"""
from app.models.calc import DailyNav, DailyXirr
from app.models.cashflow import CashBalance, CashFlow
from app.models.dividend import DividendRecord
from app.models.enums import (
    CashFlowType,
    DividendType,
    InterfaceDirection,
    JobKind,
    JobRunStatus,
    JobTaskType,
    JobTriggerSource,
    QuoteProviderAccessMethod,
    SecuritySide,
    SecurityType,
    SnapshotSource,
    SnapshotValuation,
)
from app.models.interface_category import InterfaceCategory
from app.models.job import JobConfig, JobRunLog
from app.models.notification import Notification
from app.models.portfolio import Portfolio
from app.models.quote_interface import QuoteInterface
from app.models.quote_provider import SecuritiesDataProvider
from app.models.security import PortfolioSecurity, Security, SecurityPrice, SecurityTrade
from app.models.snapshot import AssetSnapshot
from app.models.user import User, UserPreference
from app.models.user_quote_sync import UserQuoteSyncConfig

__all__ = [
    "User",
    "UserPreference",
    "Portfolio",
    "CashFlow",
    "CashBalance",
    "Security",
    "SecurityTrade",
    "SecurityPrice",
    "PortfolioSecurity",
    "AssetSnapshot",
    "SecuritiesDataProvider",
    "QuoteInterface",
    "InterfaceCategory",
    "Notification",
    "QuoteProviderAccessMethod",
    "InterfaceDirection",
    "DailyNav",
    "DailyXirr",
    "DividendRecord",
    "CashFlowType",
    "SecurityType",
    "SecuritySide",
    "SnapshotSource",
    "SnapshotValuation",
    "DividendType",
    "JobConfig",
    "JobRunLog",
    "UserQuoteSyncConfig",
    "JobTaskType",
    "JobKind",
    "JobRunStatus",
    "JobTriggerSource",
]
