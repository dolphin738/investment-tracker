"""组合 / 持仓 / 账户与偏好读模型（`modules/portfolio`、`modules/preference`，含最小化的用户与令牌投影）。

自 ``app/schemas_resp.py``（495 行、超 §4 的 400 行上限）按域拆出（A11-③）。
**对外唯一导出面仍是 ``app.schemas_resp`` 包**（见该包 ``__init__`` 的显式再导出），
故所有 ``from app.schemas_resp import X`` 与 ``schemas_resp.X`` 引用点无需改动。
拆分是纯位移：字段、类型、默认值与注释逐字保留（护栏：重跑 ``gen_openapi.py``
后 ``docs/openapi.json`` 必须零 diff）。
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from pydantic import BaseModel

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
    greenThreshold: float
    redThreshold: float
    dashboardLayout: str


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
