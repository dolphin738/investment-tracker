"""股息率与待人工划分读模型（`modules/dividend_yield`）。

自 ``app/schemas_resp.py``（495 行、超 §4 的 400 行上限）按域拆出（A11-③）。
**对外唯一导出面仍是 ``app.schemas_resp`` 包**（见该包 ``__init__`` 的显式再导出），
故所有 ``from app.schemas_resp import X`` 与 ``schemas_resp.X`` 引用点无需改动。
拆分是纯位移：字段、类型、默认值与注释逐字保留（护栏：重跑 ``gen_openapi.py``
后 ``docs/openapi.json`` 必须零 diff）。
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Literal, Optional

from pydantic import BaseModel

# §5.2b 续批（S13）：枚举字段用**真实枚举类型**而非裸 str——否则 OpenAPI 里没有 enum，
# 前端只能手写联合，后端加枚举值时前端下拉静默漏项（单一事实源在 models/enums.py）。
from app.models.enums import DividendPendingStatus, DividendStatus, ReportPeriodType

class PendingDividendOut(BaseModel):
    """待人工划分分红行（列表项）。金额 Decimal → str（信封编码器保证）。"""

    id: str
    masterId: str
    code: Optional[str] = None
    name: Optional[str] = None
    exchange: Optional[str] = None
    dividendLabel: Optional[str] = None
    cashPerShare: str
    # S11：展示文案由**后端**产出（与 `/{master_id}/dividends` 的 periodLabel/planLabel 同口径），
    # 前端不再自行拼「YYYY QX · 类型中文」——否则同一报告期在两个页面文案不一致。
    planLabel: str
    resolvedPeriodLabel: Optional[str] = None
    bonusShareRatio: Optional[str] = None
    convertRatio: Optional[str] = None
    recordDate: Optional[date] = None
    exDividendDate: Optional[date] = None
    payDate: Optional[date] = None
    announcementDate: Optional[date] = None
    reportPeriodRaw: Optional[str] = None
    status: DividendPendingStatus  # PENDING|ASSIGNED|IGNORED
    resolvedPeriodType: Optional[ReportPeriodType] = None
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
    status: DividendPendingStatus
    conflict: bool
    warning: Optional[str] = None
    reportYear: int
    reportQuarter: int
    periodType: ReportPeriodType


class PendingIgnoreResultOut(BaseModel):
    id: str
    status: DividendPendingStatus


class PendingReopenResultOut(BaseModel):
    id: str
    status: DividendPendingStatus
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
    periodType: ReportPeriodType
    periodLabel: str
    planLabel: str
    cashPerShare: str
    dividendLabel: Optional[str] = None
    # 每股送股 / 转增比例（股；字符串防前端类型漂移）；无送转为 null。
    # 落入明细列表时前端折算为「送 Y 股 / 转 Z 股」（每 10 股口径）。
    bonusShareRatio: Optional[str] = None
    convertRatio: Optional[str] = None
    status: DividendStatus
    exDividendDate: Optional[date] = None
    announcementDate: Optional[date] = None


class SecurityDividendListOut(BaseModel):
    masterId: str
    items: list[SecurityDividendItemOut] = []


class DividendSecurityItemOut(BaseModel):
    """所有有分红证券（GET /securities 列表项；§10.2 股息价格推算选择框候选）。

    字段名沿用 wire 实际形状（snake_case，与 SeedProgressOut 同款「wire 逐字一致」惯例）。
    """

    master_id: str
    code: Optional[str] = None
    name: Optional[str] = None
    exchange: Optional[str] = None
    # 每股现金分红（元）：Decimal 经信封编码器 → str（见包 __init__ 契约惯例）。
    numerator_per_share: Optional[str] = None


class DividendSecurityListOut(BaseModel):
    """GET /securities 响应（无分页上限，全量候选）。"""

    items: list[DividendSecurityItemOut] = []


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


# —— S15：首跑播种进度（进程内内存态）——
# 此前 `SeedProgress` 只存在于前端手写类型与后端 `trigger_router` 的手工 dict 两处：
# 字段改名只会让面板显示 `undefined`，而 `vue-tsc` 无感。现纳入契约，前端类型随生成物走。
# 字段名/可选性必须与 `trigger_router.py` 的返回 dict 逐字一致
# （护栏：tests/test_dividend_yield_api.py::test_seed_progress_wire_matches_response_model）。
class SeedFailedSecurityOut(BaseModel):
    """播种失败证券（进度面板展开清单的一行）。"""

    master_id: str
    code: str
    name: str


class SeedProgressOut(BaseModel):
    """首跑播种运行进度（GET /seed-initial-dividends/progress）。"""

    # Literal（非裸 str）：进契约成 openapi enum → 前端生成联合类型，后端新增 state 时
    # 前端 switch/三元漏分支会由 vue-tsc 报错，而非静默不轮询（§4 收口）。
    state: Literal["idle", "running", "done", "error", "cancelled"]
    # S9 ②B：state 语义为「任务在其它进程运行」（本进程 idle + DB 锁被他人持有未过期）。
    # 此态下 total/processed 等计数为零值（本进程看不到对方内存态），取消仍可跨进程生效。
    running_elsewhere: bool = False
    total: int
    processed: int
    hits: int
    failed: int
    covered: int
    started_at: Optional[str]
    finished_at: Optional[str]
    error: Optional[str]
    message: Optional[str]
    failed_securities: list[SeedFailedSecurityOut]  # 上限见服务端 _FAILED_IDS_CAP
    failed_truncated: bool
