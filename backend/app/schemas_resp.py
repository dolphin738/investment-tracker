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
    name: str
    description: Optional[str] = None
    baseDate: date
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
    name: str
    avatar: Optional[str] = None


class AuthTokenOut(BaseModel):
    accessToken: str
    user: UserPublicOut


# ───────────────────────── 数据实体 ─────────────────────────
class CashflowOut(BaseModel):
    id: str
    date: date
    type: str
    amount: str
    note: Optional[str] = None
    createdAt: datetime


class SecurityOut(BaseModel):
    id: str
    code: str
    name: str
    type: str
    currency: str
    createdAt: datetime


class TradeOut(BaseModel):
    id: str
    securityId: str
    date: date
    side: str
    quantity: str
    price: str
    fee: str
    note: Optional[str] = None
    createdAt: datetime


class PriceOut(BaseModel):
    id: str
    securityId: str
    price: str
    asOf: date
    createdAt: datetime


class CashBalanceOut(BaseModel):
    id: str
    amount: str
    asOf: date
    note: Optional[str] = None
    createdAt: datetime


class SnapshotOut(BaseModel):
    id: str
    date: date
    totalAsset: Optional[str] = None
    marketValue: Optional[str] = None
    cashBalance: Optional[str] = None
    source: str
    valuationFlag: str
    note: Optional[str] = None
    recordedAt: datetime
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
    type: str
    note: Optional[str] = None
    createdAt: datetime


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
    securityId: str
    code: Optional[str] = None
    name: Optional[str] = None
    quantity: str
    avgCost: str
    costTotal: str
    price: str
    marketValue: str
    pnl: str
    ratio: str
    isCostBased: bool


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
class FreshnessOut(BaseModel):
    staleDays: int
    isStale: bool
    latestPriceAsOf: Optional[date] = None
    latestPriceLagDays: Optional[int] = None
    latestCashAsOf: Optional[date] = None
    latestCashLagDays: Optional[int] = None
    reasons: list[str] = []


class PortfolioSummaryOut(BaseModel):
    cumulativeXirr: Optional[str] = None
    totalReturnRate: Optional[str] = None
    yearReturnRate: Optional[str] = None
    maxDrawdown: Optional[str] = None
    latestDate: Optional[date] = None
    inceptionDate: date


class OverviewOut(BaseModel):
    totalAsset: Optional[str] = None
    cumulativeXirr: Optional[str] = None
    yearXirr: Optional[str] = None
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
    totalAssets: str
    cumulativeXirr: Optional[str] = None
    yearXirr: Optional[str] = None


# ───────────────────────── 数据导入导出 ─────────────────────────
class ImportPreviewOut(BaseModel):
    type: str
    totalRows: int
    validRows: int
    sample: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    minDate: Optional[date] = None
    token: str


class ImportCommitOut(BaseModel):
    inserted: int
    updated: int
    skipped: int
    failed: list[dict[str, Any]] = []
    recalculated: Optional[dict[str, Any]] = None
