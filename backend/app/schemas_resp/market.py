"""行情 / 交易 / 现金流 / 快照读模型（`modules/data`，含序列化层共用的 `RecalculationMeta`）。

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

from app.models.enums import (
    CashFlowType,
    DividendType,
    SecuritySide,
    SecurityType,
    SnapshotSource,
    SnapshotValuation,
)

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
    exchange: Optional[str] = None
    currency: str
    masterId: str
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
