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
    ON_EXCHANGE_FUND = "ON_EXCHANGE_FUND"  # 场内基金（含原 ETF/LOF 合并）
    BOND = "BOND"
    OTHER = "OTHER"
    # —— 证券主数据多资产类别扩展（§11.3，配置驱动，零硬编码）——
    HK_STOCK = "HK_STOCK"
    CONVERTIBLE_BOND = "CONVERTIBLE_BOND"
    INDEX = "INDEX"
    OFF_EXCHANGE_FUND = "OFF_EXCHANGE_FUND"  # 场外基金（银行/第三方代销开放式基金）
    UNCATEGORIZED = "UNCATEGORIZED"  # 未分类：代码无法可靠推断具体类别时兜底（如场外基金与 A股 同前缀）


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


class InterfaceDirection(str, enum.Enum):
    """提供方接口方向（入站 / 出站）。

    PG 原生枚举类型名 `interface_direction`（由迁移创建）。
    业务当前仅落库使用（默认 in），UI 不暴露该字段。
    """

    IN = "in"
    OUT = "out"


class JobTaskType(str, enum.Enum):
    """定时任务类型（统一调度器处理器注册表键 + 数据库任务类型列）。

    系统任务（不可追加/删除，仅可编辑）由迁移种子写入；普通任务（可增删改）在
    定时任务管理页由管理员新建。两者共用本枚举。
    """

    MARKET_DATA_SYNC = "MARKET_DATA_SYNC"  # 行情同步（遍历组合拉实时价，普通可建）
    SECURITY_MASTER_SYNC = "SECURITY_MASTER_SYNC"  # 证券主数据同步（普通可建）
    LOCAL_COMMAND = "LOCAL_COMMAND"  # 定时执行本地脚本/命令（普通可建）
    HTTP_CALLBACK = "HTTP_CALLBACK"  # HTTP 回调（普通可建）
    ACCOUNT_CLEANUP = "ACCOUNT_CLEANUP"  # 账户物理清理（系统任务，迁移种子写入）


class JobKind(str, enum.Enum):
    """任务归类：系统任务仅可编辑不可删除；普通任务可增删改。"""

    SYSTEM = "SYSTEM"
    NORMAL = "NORMAL"


class JobRunStatus(str, enum.Enum):
    """任务单次执行结果状态（JobRunLog）。"""

    RUNNING = "RUNNING"
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"


class JobTriggerSource(str, enum.Enum):
    """任务触发来源：调度器定时触发 / 管理员手动立即执行。"""

    SCHEDULED = "SCHEDULED"
    MANUAL = "MANUAL"
