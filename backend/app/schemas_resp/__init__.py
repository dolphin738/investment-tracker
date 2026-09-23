"""响应模型（OpenAPI 单一真相源 · 方案A）—— 按域拆分后的**统一导出面**（A11-③）。

背景（逐字承自原 ``schemas_resp.py``）：
- 信封机制（EnvelopeRoute）把 handler 返回值包成 EnvelopeJSONResponse（Response 子类），
  FastAPI 的 serialize_response 见到 Response 即原样透传、**跳过 response_model 校验**。
  因此给路由声明 response_model 在运行时零风险，仅用于把实体 schema 暴露给 OpenAPI。
- Decimal 金额经 decimal_jsonable_encoder 序列化为字符串，故金额字段用 `str`；
  日期/时间字段用 `date`/`datetime`（wire 为 ISO 字符串）。这与前端 wire 格式一致。

这些模型只描述「信封内 data 的形状」，信封本身（{code,data,message}）由前端 api-client 解包。

**拆分说明**：原单文件 495 行已超 ``docs/架构治理规范.md`` §4 的 400 行上限，按域拆到本包下
各模块（common / portfolio / market / calc / transfer / dividend_yield）。本 ``__init__`` 显式
再导出**全部**符号并声明 ``__all__``，故 ``from app.schemas_resp import X`` 与
``schemas_resp.X``（如 ``tests/test_contract.py``）两种引用方式**完全不变**。
"""
from __future__ import annotations

from app.schemas_resp.calc import (
    NavPointOut,
    XirrPointOut,
    XirrLatestOut,
    RecalcOut,
    FreshnessReasonOut,
    FreshnessOut,
    PortfolioSummaryOut,
    PortfolioSummaryRow,
    HoldingsSummaryOut,
    OverviewOut,
    DrawdownPointOut,
    AccountStatsOut,
)
from app.schemas_resp.common import (
    Paginated,
    ClearDataOut,
)
from app.schemas_resp.dividend_yield import (
    PendingDividendOut,
    PendingDividendSummaryOut,
    PendingAssignResultOut,
    PendingIgnoreResultOut,
    PendingReopenResultOut,
    BatchFailedItemOut,
    BatchOperationOut,
    SecurityDividendItemOut,
    SecurityDividendListOut,
    DividendYieldSourceRefOut,
    DividendYieldSettingsOut,
)
from app.schemas_resp.market import (
    RecalculationMeta,
    CashflowOut,
    SecurityOut,
    TradeOut,
    PriceOut,
    CashBalanceOut,
    SnapshotOut,
    DividendOut,
)
from app.schemas_resp.portfolio import (
    PortfolioOut,
    UserPublicOut,
    AuthTokenOut,
    PreferenceOut,
    HoldingOut,
    HoldingsAggregateOut,
    HoldingsOut,
)
from app.schemas_resp.transfer import (
    ImportRowError,
    ImportPreviewOut,
    ImportCommitOut,
)

__all__ = [
    "AccountStatsOut",
    "AuthTokenOut",
    "BatchFailedItemOut",
    "BatchOperationOut",
    "CashBalanceOut",
    "CashflowOut",
    "ClearDataOut",
    "DividendOut",
    "DividendYieldSettingsOut",
    "DividendYieldSourceRefOut",
    "DrawdownPointOut",
    "FreshnessOut",
    "FreshnessReasonOut",
    "HoldingOut",
    "HoldingsAggregateOut",
    "HoldingsOut",
    "HoldingsSummaryOut",
    "ImportCommitOut",
    "ImportPreviewOut",
    "ImportRowError",
    "NavPointOut",
    "OverviewOut",
    "Paginated",
    "PendingAssignResultOut",
    "PendingDividendOut",
    "PendingDividendSummaryOut",
    "PendingIgnoreResultOut",
    "PendingReopenResultOut",
    "PortfolioOut",
    "PortfolioSummaryOut",
    "PortfolioSummaryRow",
    "PreferenceOut",
    "PriceOut",
    "RecalcOut",
    "RecalculationMeta",
    "SecurityDividendItemOut",
    "SecurityDividendListOut",
    "SecurityOut",
    "SnapshotOut",
    "TradeOut",
    "UserPublicOut",
    "XirrLatestOut",
    "XirrPointOut",
]
