"""待人工划分分红端点（批次 C，§4）。

七端点（六 + reopen）：

- ``GET  /api/dividend-yield/pending-dividends``          分页 + 筛选（status/label/q）
- ``GET  /api/dividend-yield/pending-dividends/summary``  计数 + ``labels[]`` 候选集
- ``POST /api/dividend-yield/pending-dividends/{id}/assign``
- ``POST /api/dividend-yield/pending-dividends/batch-assign``
- ``POST /api/dividend-yield/pending-dividends/{id}/ignore``
- ``POST /api/dividend-yield/pending-dividends/batch-ignore``
- ``POST /api/dividend-yield/pending-dividends/{id}/reopen``

约定（§4）：
- **读端点** ``require_any_role("admin","auditor")``；**写端点** ``require_admin``（D-6）。
- **子 router 自带 ``route_class=EnvelopeRoute``**：``include_router`` **不继承** route_class，
  不带则端点返回值不会被包成统一信封（见 ``admin/router.py`` 同类警告）。
- **静态段（summary / batch-*）声明在 ``{id}`` 子段之前**，免踩「``{id}`` 吞掉静态段」。
- **每端点均声明 Pydantic ``response_model``**：否则 openapi schema 为空、前端无字段类型。
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Path, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.envelope import EnvelopeRoute
from app.db.database import get_db
from app.schemas_resp import (
    BatchOperationOut,
    Paginated,
    PendingAssignResultOut,
    PendingDividendOut,
    PendingDividendSummaryOut,
    PendingIgnoreResultOut,
    PendingReopenResultOut,
)
from app.services.auth import CurrentUser, require_admin, require_any_role
from app.services.dividend_pending import PendingDividendService

router_pending = APIRouter(route_class=EnvelopeRoute)

# 读端点：admin / auditor 均可读（D-6）；写端点：仅 admin
_read = require_any_role("admin", "auditor")


# ───────────────────────── 请求模型（extra="forbid"） ─────────────────────────
class PendingAssignBody(BaseModel):
    """划分单笔请求体。

    ``reportQuarter`` 用 Field 约束（非法 → 400）；批量项刻意不加约束，改由服务层逐项
    校验并在 ``failed[]`` 回报 ``VALIDATION_FAILED``（支持批量部分失败）。
    """

    model_config = ConfigDict(extra="forbid")

    reportYear: int = Field(..., ge=1990)
    reportQuarter: int = Field(..., ge=1, le=4)
    periodType: str


class PendingAssignItem(BaseModel):
    """批量划分单条（无约束 → 项级校验由服务层完成）。"""

    model_config = ConfigDict(extra="forbid")

    id: str
    reportYear: int
    reportQuarter: int
    periodType: str


class PendingBatchAssignBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[PendingAssignItem] = Field(..., min_length=1, max_length=200)


class PendingBatchIgnoreBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ids: list[str] = Field(..., min_length=1, max_length=200)


# ───────────────────────── 读端点（admin / auditor） ─────────────────────────
@router_pending.get("/pending-dividends", response_model=Paginated[PendingDividendOut])
async def list_pending_dividends(
    user: CurrentUser = Depends(_read),
    db: AsyncSession = Depends(get_db),
    status: Optional[str] = Query(None),
    label: Optional[str] = Query(None),
    q: Optional[str] = Query(None, max_length=50),
    page: int = Query(1, ge=1),
    pageSize: int = Query(20, ge=1, le=200),
):
    """待划分分页列表：固定排序 ``created_at DESC, id DESC``；筛选 status/label/q（§4.5）。"""
    svc = PendingDividendService(db)
    return await svc.list_pending(
        status=status, label=label, q=q, page=page, page_size=pageSize
    )


@router_pending.get("/pending-dividends/summary", response_model=PendingDividendSummaryOut)
async def pending_dividends_summary(
    user: CurrentUser = Depends(_read),
    db: AsyncSession = Depends(get_db),
):
    """待划分概览：各状态计数 + ``labels[]``（``KNOWN_LABELS`` ∪ 表内标签，D-8）。"""
    return await PendingDividendService(db).summary()


# ───────────────────────── 写端点（admin） ─────────────────────────
@router_pending.post("/pending-dividends/batch-assign", response_model=BatchOperationOut)
async def batch_assign_pending(
    body: PendingBatchAssignBody,
    admin: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """批量划分：逐项独立提交，部分失败返回 ``{succeeded, failed[]}``。"""
    items = [
        {
            "id": item.id,
            "report_year": item.reportYear,
            "report_quarter": item.reportQuarter,
            "period_type": item.periodType,
        }
        for item in body.items
    ]
    return await PendingDividendService(db).batch_assign(items, user_id=admin.user_id)


@router_pending.post("/pending-dividends/batch-ignore", response_model=BatchOperationOut)
async def batch_ignore_pending(
    body: PendingBatchIgnoreBody,
    admin: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """批量忽略：逐项独立提交，部分失败返回 ``{succeeded, failed[]}``。"""
    return await PendingDividendService(db).batch_ignore(body.ids)


@router_pending.post(
    "/pending-dividends/{pending_id}/assign", response_model=PendingAssignResultOut
)
async def assign_pending(
    body: PendingAssignBody,
    pending_id: str = Path(...),
    admin: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """划分单笔：写回主表 + 置 ``ASSIGNED``；主表同格已存在则 ``conflict=True`` 不覆盖。"""
    return await PendingDividendService(db).assign(
        pending_id,
        report_year=body.reportYear,
        report_quarter=body.reportQuarter,
        period_type=body.periodType,
        user_id=admin.user_id,
    )


@router_pending.post(
    "/pending-dividends/{pending_id}/ignore", response_model=PendingIgnoreResultOut
)
async def ignore_pending(
    pending_id: str = Path(...),
    admin: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """忽略单笔：仅 ``PENDING`` 可忽略 → ``IGNORED``（不写回主表）。"""
    return await PendingDividendService(db).ignore(pending_id)


@router_pending.post(
    "/pending-dividends/{pending_id}/reopen", response_model=PendingReopenResultOut
)
async def reopen_pending(
    pending_id: str = Path(...),
    admin: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """撤销单笔：仅 ``ASSIGNED`` 可撤销；连带删除 assign 写入的主表同键行（§4.6）。"""
    return await PendingDividendService(db).reopen(pending_id)
