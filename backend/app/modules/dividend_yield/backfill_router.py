"""股息率手工触发端点（方案 §9，阶段 4；自 router.py 拆分而来）。

承载两类手动触发端点：全量重建 ``/rebuild``、全市场历史分红首跑播种
``/seed-initial-dividends``。

口径/校验复用 services 纯函数与 helper，本模块仅编排触发与后台任务托管。
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends

from app.core.bg import track_task
from app.core.enums import BusinessErrorCode
from app.core.envelope import EnvelopeRoute
from app.core.exceptions import BusinessException
from app.services.auth import CurrentUser, require_admin
from app.services.log import record

router_backfill = APIRouter(route_class=EnvelopeRoute)

# 进程内单飞锁（行动项 8，设计 §6.2）：播种是「一次性全市场冷启动」（约 11430 只 ×
# ≈6s ≈ 19h，接口限流 10/min），连点会并发启动多个 19h 任务、双倍打满限流预算。
# 模块级 asyncio.Lock 保证**同进程内至多一个播种在跑**：已在运行时再次触发立即拒绝
# （409）而不新建任务。
# 为何「检查-获取」无竞态：单进程内 asyncio 事件循环单线程，locked() 判定与其后
# acquire() 之间**没有 await 让出点**（acquire() 在未持有时同步完成），故相对其他请求
# 是原子的。
_seed_lock = asyncio.Lock()


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
# 首跑播种：全市场历史分红补齐（§5.7，冷启动一次性；异步后台执行、立即返回）
#
# §9.3-A7 裁决：**不注册 JobType、不进 services/scheduler.py 的 _HANDLERS 映射、
# 不在应用启动时自动执行**。原因：全市场约 11430 只 × 约 6s ≈ 19 小时（§7），放进
# 定时会每天重跑并打满 rate_limit=10/min 预算；播种本质是冷启动一次性动作，故沿用旧
# 回补的 HTTP fire-and-forget 形态，唯一入口是管理端「补齐历史分红」按钮。
# --------------------------------------------------------------------------- #
async def _run_seed() -> None:
    """后台执行首跑播种（独立会话，fire-and-forget）；结束时释放单飞锁。

    直接复用 services 的 ``run_dividend_seed(None)``（内部自建会话），此处仅包裹为
    后台任务并经 ``track_task`` 持有强引用防 GC 回收。

    单飞锁在 ``seed_initial_dividends`` 内**获取**、在此处 ``finally`` **释放**——即
    「锁的生命周期 = 后台任务的生命周期」。无论播种正常返回、抛错还是被取消，finally
    都释放锁，避免一次失败把播种永久锁死。
    """
    from app.services.dividend_seed import run_dividend_seed

    try:
        await run_dividend_seed(None)
    finally:
        _seed_lock.release()


@router_backfill.post("/seed-initial-dividends")
async def seed_initial_dividends(
    admin: CurrentUser = Depends(require_admin),
):
    """手动触发全市场历史分红播种（§5.7；admin-only）。

    遍历全市场约 11430 只，并按 rate_limit 串行逐只调巨潮，长耗时（约 19 小时）故
    fire-and-forget 立即返回；支持断点续跑（按「当前明细源 + 近 5 年」判定已覆盖者
    跳过），中途失败重跑会自动续跑。进度与结果经应用日志查看。

    **单飞**（行动项 8，§6.2）：已在播种中再次触发 → 不新建任务，返回 409
    「已有播种任务在运行」，避免连点并发启动多个 19h 任务打满限流预算。
    """
    # 单飞判定放在依赖校验（require_admin）之后：非 admin 已在依赖层被 403 拦下。
    if _seed_lock.locked():
        raise BusinessException(
            # 项目无通用「资源占用」业务码（既有 409 均为领域专属：1003/1007/1008）；
            # 对齐 pending 服务对「状态冲突」的既有表达（VALIDATION_FAILED + 显式 409，
            # 见 dividend_pending._to_http_exception），不自创错误码（否则需同步 shared）。
            code=BusinessErrorCode.VALIDATION_FAILED,
            message="已有播种任务在运行",
            status_code=409,
        )
    # 先取锁再创建后台任务：保证「任务在跑」期间锁始终被持有；_run_seed 的 finally 释放。
    await _seed_lock.acquire()
    track_task(asyncio.create_task(_run_seed()))
    await record(
        level="info",
        scope="admin",
        module="dividend_seed",
        message="历史分红补齐（手动触发，异步后台执行）",
        user_id=admin.user_id,
    )
    return {
        # §4.4 契约漂移：前端旧声明含 job_id，但后端从不返回 job_id（无 JobType、
        # 无 job_task 行可对应），故返回体只保留 message。
        "message": "已触发历史分红补齐，后台执行中；进度见应用日志",
    }
