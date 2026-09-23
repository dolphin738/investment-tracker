"""股息率与待人工划分读模型（`modules/dividend_yield`）。

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

class PendingDividendOut(BaseModel):
    """待人工划分分红行（列表项）。金额 Decimal → str（信封编码器保证）。"""

    id: str
    masterId: str
    code: Optional[str] = None
    name: Optional[str] = None
    exchange: Optional[str] = None
    dividendLabel: Optional[str] = None
    cashPerShare: str
    bonusShareRatio: Optional[str] = None
    convertRatio: Optional[str] = None
    recordDate: Optional[date] = None
    exDividendDate: Optional[date] = None
    payDate: Optional[date] = None
    announcementDate: Optional[date] = None
    reportPeriodRaw: Optional[str] = None
    status: str  # PENDING|ASSIGNED|IGNORED
    resolvedPeriodType: Optional[str] = None
    resolvedReportYear: Optional[int] = None
    resolvedReportQuarter: Optional[int] = None
    createdAt: datetime
    resolvedAt: Optional[datetime] = None


class PendingDividendSummaryOut(BaseModel):
    """待划分概览：各状态计数 + 标签候选集（D-8）。"""

    pending: int
    assigned: int
    ignored: int
    total: int
    labels: list[str] = []  # KNOWN_LABELS ∪ 表内 DISTINCT 非空 label


class PendingAssignResultOut(BaseModel):
    id: str
    status: str
    conflict: bool
    warning: Optional[str] = None
    reportYear: int
    reportQuarter: int
    periodType: str


class PendingIgnoreResultOut(BaseModel):
    id: str
    status: str


class PendingReopenResultOut(BaseModel):
    id: str
    status: str
    rolledBack: bool  # 是否连带删除了主表同键行


class BatchFailedItemOut(BaseModel):
    id: str
    code: str  # NOT_FOUND|INVALID_STATE|VALIDATION_FAILED|DB_ERROR
    reason: str


class BatchOperationOut(BaseModel):
    """批量端点统一响应：成功数 + 逐项失败明细。"""

    succeeded: int
    failed: list[BatchFailedItemOut] = []


class SecurityDividendItemOut(BaseModel):
    reportYear: int
    reportQuarter: int
    periodType: str
    periodLabel: str
    planLabel: str
    cashPerShare: str
    dividendLabel: Optional[str] = None
    status: str
    exDividendDate: Optional[date] = None
    announcementDate: Optional[date] = None


class SecurityDividendListOut(BaseModel):
    masterId: str
    items: list[SecurityDividendItemOut] = []


class DividendYieldSourceRefOut(BaseModel):
    """已 resolve 的数据源接口引用（读侧投影 ``{id, name}``；未配置为 null）。"""

    id: str
    name: str


class DividendYieldSettingsOut(BaseModel):
    """股息率全局配置（GET /settings 与 PUT /settings **同形**）。"""

    dividend_detail_source: Optional[DividendYieldSourceRefOut]
    price_source: Optional[DividendYieldSourceRefOut]
    announcement_source: Optional[DividendYieldSourceRefOut]
    trade_calendar_start_date: Optional[date]  # YYYY-MM-DD；None = 未配置（后端用默认下限）
    # 1~10，**非空**：`_settings_out` 保证「未配置（无行 / 显式 NULL）→ 回落默认 5」，
    # 故契约上该字段恒为有效值（前端据此算建议留存窗，不必再自行兜底）。
    dividend_retention_years: int
