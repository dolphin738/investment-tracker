"""请求体 Schema（Pydantic v2）。

仅用于入参校验；响应由 EnvelopeRoute 包裹，字段名与 app 契约一致（驼峰）。
金额统一用 DecimalStr（序列化与 OpenAPI schema 均为字符串，对齐 Prisma Decimal 行为）。
"""
from __future__ import annotations

from datetime import date
import datetime
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.types import DecimalStr
from app.models.enums import ImportType

# 邮箱格式（轻量正则；不引入 email-validator 依赖，避免 venv 隔离外溢）。
# 与 shared 端 BUSINESS_ERROR_CODE 无关，仅做入参格式门禁（REP-010）。
_EMAIL_RE = __import__("re").compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


# ── 认证 ──
class RegisterReq(BaseModel):
    email: str
    password: str = Field(min_length=8)
    name: Optional[str] = None

    @field_validator("email")
    @classmethod
    def _check_email(cls, v: str) -> str:
        if not _EMAIL_RE.match(v or ""):
            raise ValueError("邮箱格式无效")
        return v


class LoginReq(BaseModel):
    email: str
    password: str


class ProfilePatchReq(BaseModel):
    name: Optional[str] = None
    avatar: Optional[str] = None
    phone: Optional[str] = None
    bio: Optional[str] = None


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

    @field_validator("amount")
    @classmethod
    def _amount_positive(cls, v: Decimal) -> Decimal:
        if v <= 0:
            raise ValueError("金额必须大于 0")
        return v


class CashflowPatchReq(BaseModel):
    date: Optional[datetime.date] = None
    type: Optional[str] = None
    amount: Optional[DecimalStr] = None
    note: Optional[str] = None


# ── 标的 ──
class SecurityPatchReq(BaseModel):
    """组合标的 PATCH：仅允许 type override（name 等维度归目录主数据）。"""

    type: Optional[str] = None


class SecurityResolveReq(BaseModel):
    """录入界面证券搜索选中后，懒实例化为组合标的的幂等 upsert 请求体（ADR-003）。

    必须选中目录主数据（combobox 搜索 → 点击选中 → 传 masterId），不再支持手输 code。
    type 为可选 override；不传则读取时由代码前缀推断（infer_security_type）。
    """

    model_config = ConfigDict(populate_by_name=True)

    master_id: str = Field(..., alias="masterId", description="目录主数据 id（securities.id）")
    type: Optional[str] = Field(None, description="可选 type override；不传=按代码前缀推断")


# ── 证券买卖 ──
class TradeCreateReq(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    date: date
    securityId: str
    side: str  # BUY_SEC / SELL_SEC
    quantity: DecimalStr
    cost_price: DecimalStr = Field(alias="costPrice")  # 含费单价（对齐 app/ INC-03）
    fee_total: Optional[DecimalStr] = Field(default=Decimal(0), alias="feeTotal")
    commission: Optional[DecimalStr] = Decimal(0)
    stamp_tax: Optional[DecimalStr] = Field(default=Decimal(0), alias="stampTax")
    other: Optional[DecimalStr] = Decimal(0)
    note: Optional[str] = None

    @field_validator("quantity", "cost_price")
    @classmethod
    def _qty_cost_price_positive(cls, v: Decimal) -> Decimal:
        if v <= 0:
            raise ValueError("数量/含费单价必须大于 0")
        return v


class TradePatchReq(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    date: Optional[datetime.date] = None
    side: Optional[str] = None
    quantity: Optional[DecimalStr] = None
    cost_price: Optional[DecimalStr] = Field(default=None, alias="costPrice")
    fee_total: Optional[DecimalStr] = Field(default=None, alias="feeTotal")
    commission: Optional[DecimalStr] = None
    stamp_tax: Optional[DecimalStr] = Field(default=None, alias="stampTax")
    other: Optional[DecimalStr] = None
    note: Optional[str] = None


# ── 最新价 ──
class PriceCreateReq(BaseModel):
    securityId: str
    price: DecimalStr
    asOf: date

    @field_validator("price")
    @classmethod
    def _price_positive(cls, v: Decimal) -> Decimal:
        if v <= 0:
            raise ValueError("价格必须大于 0")
        return v


class PricePatchReq(BaseModel):
    price: Optional[DecimalStr] = None
    asOf: Optional[date] = None


# ── 现金余额 ──
class CashBalanceCreateReq(BaseModel):
    amount: DecimalStr
    asOf: date
    note: Optional[str] = None

    @field_validator("amount")
    @classmethod
    def _amount_positive(cls, v: Decimal) -> Decimal:
        if v <= 0:
            raise ValueError("金额必须大于 0")
        return v


class CashBalancePatchReq(BaseModel):
    amount: Optional[DecimalStr] = None
    asOf: Optional[date] = None
    note: Optional[str] = None


# ── 总资产快照 ──
class SnapshotCreateReq(BaseModel):
    date: date
    totalAsset: DecimalStr
    marketValue: Optional[DecimalStr] = None
    cashBalance: Optional[DecimalStr] = None
    note: Optional[str] = None

    @field_validator("totalAsset")
    @classmethod
    def _total_positive(cls, v: Decimal) -> Decimal:
        if v <= 0:
            raise ValueError("总资产必须大于 0")
        return v


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

    @field_validator("amount")
    @classmethod
    def _amount_positive(cls, v: Decimal) -> Decimal:
        if v <= 0:
            raise ValueError("金额必须大于 0")
        return v


class DividendPatchReq(BaseModel):
    securityId: Optional[str] = None
    date: Optional[datetime.date] = None
    amount: Optional[DecimalStr] = None
    tax: Optional[DecimalStr] = None
    type: Optional[str] = None
    note: Optional[str] = None


# ── 数据导入提交 §4.2.17 ──
class ImportCommitReq(BaseModel):
    type: ImportType
    token: str
