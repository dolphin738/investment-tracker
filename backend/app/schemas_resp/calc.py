"""净值 / XIRR / 组合概览与聚合读模型（`modules/calculation`、`modules/aggregation`）。

自 ``app/schemas_resp.py``（495 行、超 §4 的 400 行上限）按域拆出（A11-③）。
**对外唯一导出面仍是 ``app.schemas_resp`` 包**（见该包 ``__init__`` 的显式再导出），
故所有 ``from app.schemas_resp import X`` 与 ``schemas_resp.X`` 引用点无需改动。
拆分是纯位移：字段、类型、默认值与注释逐字保留（护栏：重跑 ``gen_openapi.py``
后 ``docs/openapi.json`` 必须零 diff）。
"""
from __future__ import annotations

from datetime import date
from typing import Optional

from pydantic import BaseModel

from app.schemas_resp.market import CashflowOut

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
