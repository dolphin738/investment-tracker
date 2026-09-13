"""股息率手工触发端点（方案 §9，阶段 4；自 router.py 拆分而来）。

承载三类手动触发端点：全量重建 ``/rebuild``、特别分红回补 ``/backfill-specials``、
历史行情回补 ``/backfill-prices``。其中 ``/backfill-prices`` 经由本模块公共 API
``load_settings``（来自 settings_router）读取回补源配置。

口径/校验复用 services 纯函数与 helper，本模块仅编排触发与后台任务托管。
"""
from __future__ import annotations

import asyncio
from datetime import date

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.bg import track_task
from app.core.date_utils import today_app_tz
from app.core.enums import BusinessErrorCode
from app.core.envelope import EnvelopeRoute
from app.core.exceptions import BusinessException
from app.db.database import get_db
from app.models import (
    QuoteInterface,
    SecuritiesDataProvider,
)
from app.models.enums import QuoteProviderAccessMethod
from app.modules.dividend_yield.settings_router import load_settings
from app.services.auth import CurrentUser, require_admin
from app.services.log import record
from app.services.market_daily_price_sync import _select_pending_backfill_masters

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
    """后台执行特别分红历史回补（独立会话，fire-and-forget，与 /backfill-prices 同款）。

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


# --------------------------------------------------------------------------- #
# 历史行情回补（路线 B，§6.2 决策 A15；异步后台执行、立即返回）
# --------------------------------------------------------------------------- #
class BackfillPricesBody(BaseModel):
    """回补请求体：起点日期（ISO YYYY-MM-DD，必填）。"""

    start_date: date


async def _run_price_backfill() -> None:
    """后台执行在途回补首批（独立会话，fire-and-forget）。

    直接复用 ``run_pending_price_backfill``：读 settings 解析接口、精确选出本批未覆盖证券
    并回补。请求级已校验接口存在与 access_method=sdk 并写入了 ``price_backfill_start_date``，
    此处独立会话重新读 settings 即可接管整轮在途任务（与每日「收盘价抓取」续跑共用同一函数）。
    """
    from app.db.database import AsyncSessionLocal
    from app.services.market_daily_price_sync import run_pending_price_backfill

    async with AsyncSessionLocal() as session:
        await run_pending_price_backfill(session)


@router_backfill.post("/backfill-prices")
async def backfill_prices(
    body: BackfillPricesBody,
    admin: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """手动触发历史行情回补（路线 B 形态 A；admin-only，fire-and-forget 在途任务）。

    行为变更（形态 A）：写入 ``price_backfill_start_date``（= 启动在途任务），立即跑第一批
    （run_pending_price_backfill，独立会话），补完自动停止、清状态。每日「收盘价抓取」任务
    完成后若存在在途任务会按每日额度续跑。

    保留既有 400 防线：未配置接口 / 接口不存在 / 非 sdk 接入方式；``price_backfill_start_date``
    不由 PUT 设置（服务端管理，避免状态不一致）。回补长耗时，故异步后台执行、立即返回，
    进度见应用日志。响应 ``security_count`` 语义改为「本批将处理的只数」（≤ 每日额度，
    不再是全池数）。

    **额度按自然日消耗**：同日的手动触发与每日「收盘价抓取」续跑共享 ``price_backfill_quota``，
    已用只数记在 ``price_backfill_used_today``（跨日自动归零）。余额 ≤ 0 时本端点 400，
    避免触发一个注定空跑的批次。

    **在途护栏（M-1）**：已有在途任务（``price_backfill_start_date`` 非空）时拒绝再次启动。
    前端会把按钮置灰，但那只是 UX 层——多标签页/多管理员/直接 curl 都能绕过，
    故本校验是唯一真正的护栏。取消请走 ``DELETE /backfill-prices``。

    **响应 ``security_count`` 为估算值**：本批名单在请求会话内算出，后台任务用独立会话
    重新选取，两者非原子，极端情况下与实际处理只数可能有偏差。
    """
    settings = await load_settings(db)
    # 在途护栏（M-1）：已有在途任务则拒绝再次启动。
    # 两个并发任务会各自 SELECT 出**同一批**待补证券（回补长耗时，批完成前这些
    # 证券仍是「未覆盖」且 ORDER BY master_id 确定）→ 同一批被请求两次、配额翻倍。
    if settings.price_backfill_start_date is not None:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message=(
                "已有在途回补任务（起点 "
                f"{settings.price_backfill_start_date.isoformat()}），"
                "请先等待其完成，或先取消（DELETE /api/dividend-yield/backfill-prices）"
                "后再启动新的回补"
            ),
            status_code=400,
        )
    interface_id = settings.price_backfill_source_interface_id
    if not interface_id:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message="未配置历史行情回补接口，请先在全局设置中配置 price_backfill_source",
            status_code=400,
        )
    itf = await db.get(QuoteInterface, interface_id)
    if itf is None:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message="历史行情回补接口不存在",
            status_code=400,
        )
    provider = await db.get(SecuritiesDataProvider, itf.provider_id)
    if provider is None or provider.access_method != QuoteProviderAccessMethod.SDK:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message=(
                "历史行情回补接口接入方式须为 sdk（akshare stock_zh_a_hist），"
                f"当前接口 {itf.name!r} 的提供方接入方式为 "
                f"{provider.access_method if provider else '未知'}"
            ),
            status_code=400,
        )
    # 当日剩余额度：额度按**自然日**消耗，同日的手动触发与每日续跑共享同一份额度，
    # 故触发前先算余额（放在写 start_date 之前，避免余额为 0 时留下无效在途状态）
    quota = settings.price_backfill_quota if settings.price_backfill_quota is not None else 1000
    today = today_app_tz()
    used_today = (
        settings.price_backfill_used_today
        if settings.price_backfill_last_run_date == today
        else 0
    ) or 0
    remaining = quota - used_today
    if remaining <= 0:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message=(
                f"今日回补额度已用尽（{quota} 只/天，已用 {used_today} 只），"
                "本次不发起请求；请明日再触发（额度按自然日重置）"
            ),
            status_code=400,
        )

    # 启动在途任务：写入起点日期并落库（此后每日收盘价抓取按剩余额度续跑）
    start = body.start_date
    settings.price_backfill_start_date = start
    await db.commit()

    # 本批将处理的只数（精确选出未覆盖，限当日剩余额度），用于响应语义
    pending = await _select_pending_backfill_masters(db, start, remaining)

    # fire-and-forget：独立会话内跑首批（持有强引用防 GC 回收）
    track_task(asyncio.create_task(_run_price_backfill()))
    await record(
        level="info",
        scope="admin",
        module="dividend_price_backfill",
        message="历史行情在途回补（启动在途任务，首批后台执行）",
        detail={
            "start_date": start.isoformat(),
            "quota": quota,
            "remaining_quota": remaining,
            "security_count": len(pending),
            "interface_id": interface_id,
            "interface_name": itf.name,
        },
        user_id=admin.user_id,
    )
    return {
        "message": "已启动行情回补在途任务并跑首批（后台执行），补完自动停止（每日额度续跑）",
        "start_date": start.isoformat(),
        "security_count": len(pending),
        "quota": quota,
        "remaining_quota": remaining,
    }

# --------------------------------------------------------------------------- #
# 取消在途的历史行情回补（在途标记服务端管理，须留退路）
# --------------------------------------------------------------------------- #
@router_backfill.delete("/backfill-prices")
async def cancel_price_backfill(
    admin: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """取消在途的历史行情回补（admin-only）：清空 ``price_backfill_start_date``。

    为什么需要本端点：在途标记由服务端管理（PUT /settings 不接受该字段），
    而 ``run_pending_price_backfill`` 仅在「选出 0 只」时才自动清标记。
    若数据源持续不可达，熔断会每天触发却永远清不掉标记 → 任务无限期在途、
    每天白烧额度，而 admin 无任何 API 手段停止（只能直接改库）。

    有了取消，「已有在途任务」的 400 与前端置灰才不会把人锁死，形成闭环：
    进行中 → 取消 → 重新填起点触发。

    **能力边界（诚实说明）**：本端点仅清标记，**不中断正在运行的后台批次**——
    当前批次会跑完本批（≤ quota 只）后自然停止，此后每日收盘价抓取不再续跑。
    已写入的日线行一律保留（upsert 幂等，重跑自动跳过已覆盖证券）。
    """
    settings = await load_settings(db)
    if settings.price_backfill_start_date is None:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message="当前无在途回补任务，无需取消",
            status_code=400,
        )
    cancelled = settings.price_backfill_start_date
    settings.price_backfill_start_date = None
    settings.price_backfill_last_error = None
    await db.commit()
    await record(
        level="info",
        scope="admin",
        module="dividend_price_backfill",
        message="取消在途行情回补（已清 price_backfill_start_date）",
        detail={"cancelled_start_date": cancelled.isoformat()},
        user_id=admin.user_id,
    )
    return {
        "message": (
            f"已取消在途回补任务（原起点 {cancelled.isoformat()}）；"
            "正在运行的当前批次会跑完本批后停止，此后不再续跑，已补数据保留"
        ),
        "cancelled_start_date": cancelled.isoformat(),
    }
