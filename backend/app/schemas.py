"""请求体 Schema（Pydantic v2）。

仅用于入参校验；响应由 EnvelopeRoute 包裹，字段名与 app 契约一致（驼峰）。
金额统一用 DecimalStr（序列化与 OpenAPI schema 均为字符串，对齐 Prisma Decimal 行为）。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel

from app.core.types import DecimalStr


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


# ── 改密 / 改邮（§4.2.1）──
class PasswordPatchReq(BaseModel):
    currentPassword: str
    newPassword: str


class EmailPatchReq(BaseModel):
    currentPassword: str
    newEmail: str


# ── 组合 ──
class PortfolioCreateReq(BaseModel):
    name: str
    description: Optional[str] = None
    currency: str = "CNY"


class PortfolioPatchReq(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


class PortfolioArchiveReq(BaseModel):
    """归档请求：archived 缺省或 true → 归档；false → 取消归档。"""

    archived: Optional[bool] = None


# ── 出入金 ──
class CashflowCreateReq(BaseModel):
    date: date
    type: str  # BUY / SELL
    amount: DecimalStr
    note: Optional[str] = None


class CashflowPatchReq(BaseModel):
    date: Optional[date] = None
    type: Optional[str] = None
    amount: Optional[DecimalStr] = None
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
    quantity: DecimalStr
    price: DecimalStr
    fee: Optional[DecimalStr] = Decimal(0)
    note: Optional[str] = None


class TradePatchReq(BaseModel):
    date: Optional[date] = None
    quantity: Optional[DecimalStr] = None
    price: Optional[DecimalStr] = None
    fee: Optional[DecimalStr] = None


# ── 最新价 ──
class PriceCreateReq(BaseModel):
    securityId: str
    price: DecimalStr
    asOf: date


class PricePatchReq(BaseModel):
    price: Optional[DecimalStr] = None
    asOf: Optional[date] = None


# ── 现金余额 ──
class CashBalanceCreateReq(BaseModel):
    amount: DecimalStr
    asOf: date
    note: Optional[str] = None


class CashBalancePatchReq(BaseModel):
    amount: Optional[DecimalStr] = None
    note: Optional[str] = None


# ── 总资产快照 ──
class SnapshotCreateReq(BaseModel):
    date: date
    totalAsset: DecimalStr
    marketValue: Optional[DecimalStr] = None
    cashBalance: Optional[DecimalStr] = None
    note: Optional[str] = None


class SnapshotPatchReq(BaseModel):
    totalAsset: Optional[DecimalStr] = None
    marketValue: Optional[DecimalStr] = None
    cashBalance: Optional[DecimalStr] = None
    note: Optional[str] = None


# ── 重算 ──
class RecalculateRangeReq(BaseModel):
    startDate: Optional[date] = None
    endDate: Optional[date] = None


# ── 分红 §4.2.18 ──
class DividendCreateReq(BaseModel):
    securityId: str
    date: date
    amount: DecimalStr
    tax: Optional[DecimalStr] = Decimal(0)
    type: Optional[str] = "CASH"
    note: Optional[str] = None


class DividendPatchReq(BaseModel):
    securityId: Optional[str] = None
    date: Optional[date] = None
    amount: Optional[DecimalStr] = None
    tax: Optional[DecimalStr] = None
    type: Optional[str] = None
    note: Optional[str] = None


# ── 数据导入提交 §4.2.17 ──
class ImportCommitReq(BaseModel):
    type: str
    token: str
