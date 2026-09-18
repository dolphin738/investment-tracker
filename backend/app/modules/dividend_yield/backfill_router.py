"""股息率手工触发端点（方案 §9，阶段 4；自 router.py 拆分而来）。

承载两类手动触发端点：全量重建 ``/rebuild``、特别分红回补 ``/backfill-specials``。

口径/校验复用 services 纯函数与 helper，本模块仅编排触发与后台任务托管。
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends

from app.core.bg import track_task
from app.core.envelope import EnvelopeRoute
from app.services.auth import CurrentUser, require_admin
from app.services.log import record

router_backfill = APIRouter(route_class=EnvelopeRoute)


# --------------------------------------------------------------------------- #
# 手动全量重建（替代原系统定时任务 DIVIDEND_YIELD_REBUILD）
# --------------------------------------------------------------------------- #
@router_backfill.post("/rebuild")
async def rebuild_dividend_yield(
    admin: CurrentUser = Depends(require_admin),
):
    """手动全量重建股息率派生快照（替代原系统定时任务；admin-only）。

    委托 dividend_sync.run_dividend_yield_rebuild 在独立会话内执行并提交，返回重建摘要
    并写 AppLog 审计。重建可能耗时，前端按钮以 loading 态等待返回。
    """
    from app.services.dividend_sync import run_dividend_yield_rebuild

    summary = await run_dividend_yield_rebuild(None)
    await record(
        level="info",
        scope="admin",
        module="dividend_yield_rebuild",
        message="股息率全量重建（手动触发）",
        detail={"summary": summary},
        user_id=admin.user_id,
    )
    return {"summary": summary}


# --------------------------------------------------------------------------- #
# 特别分红历史回补（§6.9，冷启动一次性；异步后台执行、立即返回）
# --------------------------------------------------------------------------- #
async def _run_special_backfill() -> None:
    """后台执行特别分红历史回补（独立会话，fire-and-forget，异步后台执行）。

    直接复用 services 的 ``run_dividend_special_backfill(None)``（内部自建会话），
    此处仅包裹为后台任务并持有强引用防 GC 回收。按钮版取代了原系统定时任务，
    故不再依赖迁移 0011 种子的系统任务行。
    """
    from app.services.dividend_notice_scan import run_dividend_special_backfill

    await run_dividend_special_backfill(None)


@router_backfill.post("/backfill-specials")
async def backfill_special_dividends(
    admin: CurrentUser = Depends(require_admin),
):
    """手动触发特别分红历史回补（§6.9；admin-only）。

    直接 fire-and-forget 调起服务函数（不再依赖迁移 0011 种子的系统任务），
    长耗时（12~25 分钟）不阻塞请求；进度与结果经应用日志查看。
    """
    # fire-and-forget：立即返回，任务在后台执行
    track_task(asyncio.create_task(_run_special_backfill()))
    await record(
        level="info",
        scope="admin",
        module="dividend_special_backfill",
        message="特别分红历史回补（手动触发，异步后台执行）",
        user_id=admin.user_id,
    )
    return {
        "message": "已触发特别分红历史回补，后台执行中；进度见应用日志",
    }
