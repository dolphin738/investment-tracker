"""响应模型（OpenAPI 单一真相源 · 方案A）。

背景：
- 信封机制（EnvelopeRoute）把 handler 返回值包成 EnvelopeJSONResponse（Response 子类），
  FastAPI 的 serialize_response 见到 Response 即原样透传、**跳过 response_model 校验**。
  因此给路由声明 response_model 在运行时零风险，仅用于把实体 schema 暴露给 OpenAPI。
- Decimal 金额经 decimal_jsonable_encoder 序列化为字符串，故金额字段用 `str`；
  日期/时间字段用 `date`/`datetime`（wire 为 ISO 字符串）。这与前端 wire 格式一致。

这些模型只描述「信封内 data 的形状」，信封本身（{code,data,message}）由前端 api-client 解包。
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any, Generic, Optional, TypeVar

from pydantic import BaseModel

from app.models.enums import (
    CashFlowType,
    DividendType,
    ExportType,
    ImportErrorCode,
    ImportType,
    SecuritySide,
    SecurityType,
    SnapshotSource,
    SnapshotValuation,
)

T = TypeVar("T")


class Paginated(BaseModel, Generic[T]):
    """分页信封内 data：{items,total,page,pageSize}。"""

    items: list[T]
    total: int
    page: int
    pageSize: int


# ───────────────────────── 组合 ─────────────────────────
class PortfolioOut(BaseModel):
    id: str
    userId: str
    name: str
    description: Optional[str] = None
    baseDate: Optional[date] = None
    currency: str
    archivedAt: Optional[datetime] = None
    createdAt: datetime
    updatedAt: datetime


class ClearDataOut(BaseModel):
    deletedCount: dict[str, int]


# ───────────────────────── 用户 / 鉴权 ─────────────────────────
class UserPublicOut(BaseModel):
    id: str
    email: str
    name: Optional[str]  # DB 可空；后端恒返回该字段（值可为 null），故 required+nullable
    avatar: Optional[str] = None
    phone: Optional[str] = None
    bio: Optional[str] = None
    role: str = "user"  # 用户角色（user / admin），前端据此 gate 系统管理入口
    createdAt: str


class AuthTokenOut(BaseModel):
    accessToken: str
    user: UserPublicOut


# ───────────────────────── 数据实体 ─────────────────────────
class RecalculationMeta(BaseModel):
    """重算反馈（完整对齐 app/ 的 recalculation 字段，修复 D3）。"""

    fromDate: date
    affectedDays: int
    skippedManualDays: int


class CashflowOut(BaseModel):
    id: str
    portfolioId: str
    date: date
    type: CashFlowType
    amount: str
    note: Optional[str] = None
    createdAt: datetime
    updatedAt: datetime
    recalculation: Optional[RecalculationMeta] = None


class SecurityOut(BaseModel):
    id: str
    code: str
    name: str
    type: SecurityType
    currency: str
    createdAt: datetime
    updatedAt: datetime


class TradeOut(BaseModel):
    id: str
    securityId: str
    date: date
    side: SecuritySide
    quantity: str
    costPrice: str
    commission: str
    stampTax: str
    other: str
    feeTotal: str
    note: Optional[str] = None
    createdAt: datetime
    updatedAt: datetime


class PriceOut(BaseModel):
    id: str
    securityId: str
    price: str
    asOf: date
    createdAt: datetime
    updatedAt: datetime


class CashBalanceOut(BaseModel):
    id: str
    amount: str
    asOf: date
    note: Optional[str] = None
    createdAt: datetime
    updatedAt: datetime


class SnapshotOut(BaseModel):
    id: str
    portfolioId: str
    date: date
    totalAsset: Optional[str] = None
    marketValue: Optional[str] = None
    cashBalance: Optional[str] = None
    source: SnapshotSource
    valuationFlag: SnapshotValuation
    note: Optional[str] = None
    recordedAt: datetime
    createdAt: datetime
    updatedAt: datetime
    derivedTotalAsset: Optional[str] = None


class DividendOut(BaseModel):
    id: str
    securityId: str
    securityCode: Optional[str] = None
    securityName: Optional[str] = None
    date: date
    amount: str
    tax: str
    netAmount: str
    type: DividendType
    note: Optional[str] = None
    createdAt: datetime
    updatedAt: datetime


class PreferenceOut(BaseModel):
    id: str
    defaultPortfolioId: Optional[str] = None
    defaultGranularity: str
    defaultDateRange: str
    aggregation: str
    weekStartsOn: int
    navDecimals: int
    xirrDecimals: int
    theme: str
    staleDays: int
    showLiquidated: bool
    costBasisView: str
    cashHintOnCashflow: bool
    cashHintOnTrade: bool
    amountThousands: bool
    amountAbbrev: bool
    dashboardLayout: str


# ───────────────────────── 计算读取 ─────────────────────────
class HoldingOut(BaseModel):
    """单标的持仓（对齐前端 HoldingResponse 字段命名）。

    金额/数量均为字符串（Decimal → 字符串，防前端类型漂移，见信封契约）。
    """

    securityId: str
    securityCode: str = ""
    securityName: str = ""
    securityType: str = ""
    quantity: str
    avgCost: str
    costTotal: str
    marketPrice: Optional[str] = None
    priceAsOf: Optional[str] = None
    marketValue: str
    pnl: str
    pnlRate: str
    flag: str  # EXACT（有现价）/ COST_BASED（回退成本估值）


class HoldingsAggregateOut(BaseModel):
    """持仓汇总（对齐前端 HoldingsAggregate）。"""

    totalMarketValue: str
    totalCost: str
    totalProfit: str
    totalProfitRate: str
    securityCount: int


class HoldingsOut(BaseModel):
    """持仓列表响应（信封 data 字段）：items + aggregate。"""

    items: list[HoldingOut]
    aggregate: HoldingsAggregateOut


class NavPointOut(BaseModel):
    """NAV 序列点（兼容 metric=both 的 {cumulativeNav,yearNav} 与 单值 {value}）。"""

    date: date
    value: Optional[str] = None
    cumulativeNav: Optional[str] = None
    yearNav: Optional[str] = None
    shares: Optional[str] = None


class XirrPointOut(BaseModel):
    date: date
    value: Optional[str] = None


class XirrLatestOut(BaseModel):
    date: date
    xirrValue: Optional[str] = None


class RecalcOut(BaseModel):
    affectedDates: int
    duration: int


# ───────────────────────── 聚合 ─────────────────────────
class FreshnessReasonOut(BaseModel):
    """单条「数据不新鲜」原因（对齐前端 FreshnessReason）。

    - kind: ``PRICE`` / ``CASH``，驱动前端「去更新行情 / 去更新现金余额」按钮。
    - asOf / lagDays: 该维度最新数据日期与滞后天数（``None`` 表示缺失记录）。
    - label: 给前端展示的本地化文案。
    """

    kind: str
    asOf: Optional[date] = None
    lagDays: Optional[int] = None
    label: str


class FreshnessOut(BaseModel):
    staleDays: int
    isStale: bool
    latestPriceAsOf: Optional[date] = None
    latestPriceLagDays: Optional[int] = None
    latestCashAsOf: Optional[date] = None
    latestCashLagDays: Optional[int] = None
    reasons: list[FreshnessReasonOut] = []


class PortfolioSummaryOut(BaseModel):
    cumulativeXirr: Optional[str] = None
    totalReturnRate: Optional[str] = None
    yearReturnRate: Optional[str] = None
    maxDrawdown: Optional[str] = None
    latestDate: Optional[date] = None
    inceptionDate: date


class PortfolioSummaryRow(BaseModel):
    """全部组合摘要行（GET /portfolios/summary · Web 客户端绑定此路径）。

    与 PortfolioSummaryOut（单组合 Dashboard 卡片）是不同契约，不可混淆。
    """
    id: str
    name: str
    totalAsset: str
    holdingsCount: int
    lastUpdatedAt: Optional[str] = None
    baseDate: Optional[str] = None
    currency: str
    createdAt: str
    cumulativeNav: Optional[str] = None
    yearReturnRate: Optional[str] = None
    cumulativeReturnRate: Optional[str] = None
    xirr: Optional[str] = None
    netInvested: str
    floatingProfit: Optional[str] = None


class HoldingsSummaryOut(BaseModel):
    """概览页「持仓市值」卡数据来源（缺陷4-A）。"""

    totalMarketValue: str
    totalCost: str
    totalProfit: str
    securityCount: int


class OverviewOut(BaseModel):
    totalAsset: Optional[str] = None
    cumulativeXirr: Optional[str] = None
    yearXirr: Optional[str] = None
    holdingsSummary: Optional[HoldingsSummaryOut] = None
    navSeries: list[NavPointOut] = []
    recentCashflows: list[CashflowOut] = []
    freshness: FreshnessOut


class DrawdownPointOut(BaseModel):
    date: date
    drawdown: Optional[str] = None
    peakDate: Optional[date] = None
    label: str


class AccountStatsOut(BaseModel):
    portfolioCount: int
    cashflowCount: int
    tradeCount: int
    snapshotDays: int
    recordDays: int
    firstDate: Optional[date] = None
    lastDate: Optional[date] = None


# ───────────────────────── 数据导入导出 ─────────────────────────
class ImportRowError(BaseModel):
    """导入行级错误（§4.2.17）。`code` 为 ImportErrorCode 命名枚举。"""

    row: Optional[int] = None
    field: Optional[str] = None
    code: ImportErrorCode
    message: str


class ImportPreviewOut(BaseModel):
    type: ImportType
    totalRows: int
    validRows: int
    sample: list[dict[str, Any]] = []
    errors: list[ImportRowError] = []
    minDate: Optional[date] = None
    token: str


class ImportCommitOut(BaseModel):
    inserted: int
    updated: int
    skipped: int
    failed: list[ImportRowError] = []
    recalculated: Optional[dict[str, Any]] = None
