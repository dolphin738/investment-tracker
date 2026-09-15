"""股息率手工触发端点（方案 §9，阶段 4；自 router.py 拆分而来）。

承载三类手动触发端点：全量重建 ``/rebuild``、特别分红回补 ``/backfill-specials``、
历史行情回补 ``/backfill-prices``。其中 ``/backfill-prices`` 经由本模块公共 API
``load_settings``（来自 settings_router）读取回补源配置。

口径/校验复用 services 纯函数与 helper，本模块仅编排触发与后台任务托管。
"""
from __future__ import annotations

import asyncio
from datetime import date
from uuid import uuid4

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
from app.services.market_daily_price_sync import (
    _BACKFILL_LEASE_WAIT_SECONDS,
    _select_pending_backfill_masters,
    _skip_exchange_for_source,
    clear_price_backfill_gaps,
)

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
        # 手动首批**有界等待**租约：「取消 → 立刻重新触发」时老任务要跑到下一个取消
        # 检查点才中止释放，不等就会命中「租约占用」直接跳过 → 当天什么都不跑。
        # 每日续跑链路不传（默认 0），它没空位就下次再说，不值得等。
        await run_pending_price_backfill(
            session, wait_for_lease=_BACKFILL_LEASE_WAIT_SECONDS
        )


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
    # 方案 D：腾讯历史行情接口（stock_zh_a_hist_tx）不含京A数据 → 回补名单自动跳过 BJ
    skip_exchange = _skip_exchange_for_source(itf)
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
    # 世代标记：每次触发都换一个新 UUID（与写入起点同事务）。在途任务启动时快照它，
    # 循环里比对不一致即协作式中止——「被取消」（本列清 NULL）与「被新一次触发取代」
    # （换成另一个 UUID）两种作废状态都能被识别，避免取消后立刻重新触发时老批次误判。
    settings.price_backfill_run_token = str(uuid4())
    # 起点 / 判定基准已变 → 清空严格补洞状态表（``market_price_backfill_gaps``），
    # 与写入起点**同一事务**提交。两重作用：① 旧洞（含 exhausted 的）全部失效、须按新起点
    # 重建；② 给「数据源长期给不到的日期」一条显式重试路径——gap 模式下 attempts 达阈值会置
    # exhausted 不再入批，清空即重置。⚠️ 只有此处与取消端点清空；**绝不可**在续跑里清空
    # （那会把 attempts 每天归零 → 停牌洞永远循环，护栏二形同虚设）。
    await clear_price_backfill_gaps(db)
    # rebuild（全量重抓）模式的游标同理重置：新起点 = 新一轮重抓，须从池首开始。
    # 与清洞表同事务（同属「起点/判定基准已变 → 派生进度失效」）。
    settings.price_backfill_rebuild_cursor = None
    await db.commit()

    # 本批将处理的只数（精确选出未覆盖，限当日剩余额度），用于响应语义
    pending = await _select_pending_backfill_masters(db, start, remaining, skip_exchange)

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

    **取消语义（协作式，迁移 0024）**：本端点清在途标记 + **清世代标记**
    （``price_backfill_run_token`` → NULL）。正在运行的批次会在下一个取消检查点
    （每只证券开始前 / 退避 sleep 之后 / 批间冷却分片之间）察觉并**优雅中止**：
    不再抓取剩余证券，已写入的日线行一律保留（upsert 幂等，重跑自动跳过已覆盖证券）。
    此后每日收盘价抓取因在途标记已空而不再续跑。

    诚实边界：若此刻正卡在某一只的抓取里（``asyncio.to_thread`` 内的同步 HTTP 无法被
    asyncio 取消），这一只会跑完（≤ ``_BACKFILL_FETCH_TIMEOUT`` 秒）后才中止；
    另注：本端点**不释放执行租约**（``price_backfill_running``）——它仍由中止中的
    那个 run 在自己的 ``finally`` 里释放，避免此处释放后另一个 run 立刻插进来并发。

    **同时清空严格补洞状态**：与清在途标记**同一事务**清空 ``market_price_backfill_gaps``
    （旧洞随取消一并失效、须由下次触发重建；也顺带重置 exhausted 状态）。
    ⚠️ 清空仅限本端点与 ``POST /backfill-prices`` 两处；续跑链路**绝不**清空。
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
    # 世代标记清空：正在跑的批次据此识别「自己已被取消」并优雅中止（见本函数文档串）。
    # 若之后再次触发，POST 会写入**新的** UUID，即便老批次此刻还没跑到检查点也能识别为
    # 「被取代」而中止——不会与新批次并发抓同一池子。
    settings.price_backfill_run_token = None
    # 与清在途标记同事务清空严格补洞状态（同 POST：起点/基准失效 + 重置 exhausted 重试路径）
    await clear_price_backfill_gaps(db)
    # rebuild 游标同理清空（取消即放弃本轮重抓进度）
    settings.price_backfill_rebuild_cursor = None
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
            "正在抓取的这一只会跑完、随后立即停止（协作式取消，不再等整批），"
            "剩余证券不再抓取；已补数据保留"
        ),
        "cancelled_start_date": cancelled.isoformat(),
    }
