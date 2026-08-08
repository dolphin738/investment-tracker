"""请求体 Schema（Pydantic v2）。

仅用于入参校验；响应由 EnvelopeRoute 包裹，字段名与 app 契约一致（驼峰）。
金额用 Decimal（JSON 数字解析为 Decimal，精度足够覆盖本项目金额）。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel


# ── 认证 ──
class RegisterReq(BaseModel):
    email: str
    password: str
    name: Optional[str] = None


class LoginReq(BaseModel):
    email: str
    password: str


class ProfilePatchReq(BaseModel):
    name: Optional[str] = None
    avatar: Optional[str] = None


class RestoreReq(BaseModel):
    email: str
    password: str


# ── 组合 ──
class PortfolioCreateReq(BaseModel):
    name: str
    description: Optional[str] = None
    currency: str = "CNY"


class PortfolioPatchReq(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


# ── 出入金 ──
class CashflowCreateReq(BaseModel):
    date: date
    type: str  # BUY / SELL
    amount: Decimal
    note: Optional[str] = None


class CashflowPatchReq(BaseModel):
    date: Optional[date] = None
    type: Optional[str] = None
    amount: Optional[Decimal] = None
    note: Optional[str] = None


# ── 标的 ──
class SecurityCreateReq(BaseModel):
    code: str
    name: str
    type: Optional[str] = "STOCK"
    currency: str = "CNY"


class SecurityPatchReq(BaseModel):
    name: Optional[str] = None
    type: Optional[str] = None


# ── 证券买卖 ──
class TradeCreateReq(BaseModel):
    date: date
    securityId: str
    side: str  # BUY_SEC / SELL_SEC
    quantity: Decimal
    price: Decimal
    fee: Optional[Decimal] = Decimal(0)
    note: Optional[str] = None


class TradePatchReq(BaseModel):
    date: Optional[date] = None
    quantity: Optional[Decimal] = None
    price: Optional[Decimal] = None
    fee: Optional[Decimal] = None


# ── 最新价 ──
class PriceCreateReq(BaseModel):
    securityId: str
    price: Decimal
    asOf: date


class PricePatchReq(BaseModel):
    price: Optional[Decimal] = None
    asOf: Optional[date] = None


# ── 现金余额 ──
class CashBalanceCreateReq(BaseModel):
    amount: Decimal
    asOf: date
    note: Optional[str] = None


class CashBalancePatchReq(BaseModel):
    amount: Optional[Decimal] = None
    note: Optional[str] = None


# ── 总资产快照 ──
class SnapshotCreateReq(BaseModel):
    date: date
    totalAsset: Decimal
    marketValue: Optional[Decimal] = None
    cashBalance: Optional[Decimal] = None
    note: Optional[str] = None


class SnapshotPatchReq(BaseModel):
    totalAsset: Optional[Decimal] = None
    marketValue: Optional[Decimal] = None
    cashBalance: Optional[Decimal] = None
    note: Optional[str] = None


# ── 重算 ──
class RecalculateRangeReq(BaseModel):
    startDate: Optional[date] = None
    endDate: Optional[date] = None
