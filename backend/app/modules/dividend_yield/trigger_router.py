"""股息率手工触发端点（方案 §9，阶段 4；自 router.py 拆分而来）。

承载两类手动触发端点：全量重建 ``/rebuild``、全市场历史分红首跑播种
``/seed-initial-dividends``。

口径/校验复用 services 纯函数与 helper，本模块仅编排触发与后台任务托管。
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.bg import track_task
from app.core.enums import BusinessErrorCode
from app.core.envelope import EnvelopeRoute
from app.core.exceptions import BusinessException
from app.db.database import get_db
from app.services.admin_lock import (
    LOCK_DIVIDEND_SEED,
    acquire_admin_lock,
    release_admin_lock,
    request_cancel,
)
from app.services.auth import CurrentUser, require_admin
from app.services.log import record

logger = logging.getLogger(__name__)

router_trigger = APIRouter(route_class=EnvelopeRoute)

# 进程内单飞锁（行动项 8，设计 §6.2）**第一层**：播种是「一次性冷启动」（serviceable
# STOCK 子集约 5923 只 × ≈6s ≈ 10h，接口限流 10/min），连点会并发启动多个任务、双倍打满
# 限流预算。模块级 asyncio.Lock 保证**同进程内至多一个播种在跑**：已在运行时再次触发
# 立即拒绝（409）而不新建任务。
# 为何「检查-获取」无竞态：单进程内 asyncio 事件循环单线程，locked() 判定与其后
# acquire() 之间**没有 await 让出点**（acquire() 在未持有时同步完成），故相对其他请求
# 是原子的。
# ⚠️ 该锁**只覆盖单进程**：多 worker / 多副本部署下每个进程各持一个 Lock、互不可见，
# 连点仍会各自起任务 → 第二层为 DB 行级锁 ``admin_locks``（见 ``app.services.admin_lock``）：
# 先抢跨进程锁、再取本锁，两层都到手才真正创建任务（顺序不可颠倒，否则同进程连点会
# 白白打一次 DB）。
_seed_lock = asyncio.Lock()

# 当前运行中的播种后台任务引用（进程内）；供「取消」端点经 task.cancel() 中断。
# 与单飞锁同生命周期：任务结束（正常/抛错/取消）后由 _run_seed 的 finally 释放锁，
# 此处引用留作 done() 判定（取消端点据此区分「有运行中任务 / 无」）。
seed_task: asyncio.Task | None = None


# --------------------------------------------------------------------------- #
# 手动全量重建（替代原系统定时任务 DIVIDEND_YIELD_REBUILD）
# --------------------------------------------------------------------------- #
@router_trigger.post("/rebuild")
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
async def _release_admin_lock_safely(lock_token: str) -> None:
    """释放跨进程播种锁（自带会话；释放异常只记日志，不抛出）。

    独立成函数是为了让 ``asyncio.shield`` 能保护**整个释放过程**（含 ``AsyncSessionLocal``
    的上下文管理）：若把 ``async with`` 留在外层，外层被取消时上下文会立即退出并关闭会话，
    令仍在执行的释放语句失败。释放失败只记日志——TTL 到期后后续触发者会自动接管，不必把
    异常抛出掩盖播种本身的失败原因。
    """
    from app.db.database import AsyncSessionLocal

    try:
        async with AsyncSessionLocal() as session:
            await release_admin_lock(session, LOCK_DIVIDEND_SEED, lock_token)
    except Exception:  # pragma: no cover - 释放失败不应改变播种结果
        logger.warning("释放跨进程播种锁失败（TTL 到期后将自动接管）", exc_info=True)


async def _run_seed(lock_token: str) -> None:
    """后台执行首跑播种（独立会话，fire-and-forget）；结束时释放两层单飞锁。

    直接复用 services 的 ``run_dividend_seed(None)``（内部自建会话），此处仅包裹为
    后台任务并经 ``track_task`` 持有强引用防 GC 回收。

    单飞锁在 ``seed_initial_dividends`` 内**获取**、在此处 ``finally`` **释放**——即
    「锁的生命周期 = 后台任务的生命周期」。无论播种正常返回、抛错还是被取消，finally
    都释放锁，避免一次失败把播种永久锁死。

    **释放路径必须不可被取消**：取消端点可能在任务已进入本 ``finally`` 后再次
    ``task.cancel()``（此时 ``done()`` 仍为 ``False``，取消端点据它判定「有运行中任务」），
    而 ``CancelledError`` 继承 ``BaseException``、**不会被 ``except Exception`` 捕获**，
    因此会跳过 ``_seed_lock.release()``——那是全仓唯一的释放点，一旦跳过，进程内单飞锁
    永久占用（此后所有触发都被 409 拦下，只能重启后端恢复；且 ``bg.py`` 把 cancelled 当
    正常路径、不打错误日志，故障无痕）。故 ``asyncio.shield`` 隔离 DB 释放，
    ``_seed_lock.release()`` 落在内层 ``finally`` 无条件执行。
    """
    from app.services.dividend_seed import (
        run_dividend_seed,
        seed_progress,
        _seed_progress_now,
    )

    try:
        # 传入持锁令牌：播种循环在每个检查点据此续期（TTL 只承担崩溃检测）并在锁被抢占时
        # 体面退出，避免与抢占者并发跑（见 dividend_seed 的检查点实现）。
        await run_dividend_seed(None, lock_token=lock_token)
    except Exception as exc:
        # 进度可视化：任何未捕获异常（含失败率冒泡 RuntimeError）→ 置 error；
        # 正常成功路径由 seed_initial_dividends 内部置 done。
        seed_progress.state = "error"
        seed_progress.error = str(exc)
        seed_progress.finished_at = _seed_progress_now()
        raise
    finally:
        try:
            await asyncio.shield(_release_admin_lock_safely(lock_token))
        finally:
            # 防御：未持有时 release() 会抛 RuntimeError，掩盖真正的取消/异常
            if _seed_lock.locked():
                _seed_lock.release()


@router_trigger.post("/seed-initial-dividends")
async def seed_initial_dividends(
    admin: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """手动触发历史分红播种（§5.7；admin-only）。

    遍历巨潮可服务的沪深京证券（asset_class=STOCK，约 5923 只），按 rate_limit 串行
    逐只调巨潮，长耗时（约 10 小时）故 fire-and-forget 立即返回；支持断点续跑
    （按「当前明细源 + 近 5 年」判定已覆盖者跳过），中途失败重跑会自动续跑，也可经
    ``POST /seed-initial-dividends/cancel`` 主动取消（已完成部分保留）。进度经
    ``GET /seed-initial-dividends/progress`` 轮询。

    **单飞**（行动项 8，§6.2）：已在播种中再次触发 → 不新建任务，返回 409
    「已有播种任务在运行」，避免连点并发启动多个任务打满限流预算。分两层：
    进程内 ``asyncio.Lock``（第一层，零 DB 往返）+ DB 行级锁 ``admin_locks``
    （第二层，跨进程 / 多 worker 生效）。
    """
    # 单飞判定放在依赖校验（require_admin）之后：非 admin 已在依赖层被 403 拦下。
    if _seed_lock.locked():
        raise BusinessException(
            # 项目无通用「资源占用」业务码（既有 409 均为领域专属：1003/1007/1008）；
            # 对齐 pending 服务对「状态冲突」的既有表达（VALIDATION_FAILED + 显式 409，见
            # dividend_pending_assign._to_http_exception），不自创错误码（否则需同步 shared）。
            code=BusinessErrorCode.VALIDATION_FAILED,
            message="已有播种任务在运行",
            status_code=409,
        )
    # 第二层：跨进程 DB 行级锁（多 worker 下各进程的 asyncio.Lock 互不可见，须由 DB 兜底）。
    # 单条原子 upsert：被其他进程持有且未过 TTL → None → 409。
    lock_token = await acquire_admin_lock(db, LOCK_DIVIDEND_SEED)
    if lock_token is None:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message="已有播种任务在运行（另一进程持有）",
            status_code=409,
        )
    # 先取锁再创建后台任务：保证「任务在跑」期间锁始终被持有；_run_seed 的 finally 释放。
    await _seed_lock.acquire()
    global seed_task
    seed_task = track_task(asyncio.create_task(_run_seed(lock_token)))
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


@router_trigger.get("/seed-initial-dividends/progress")
async def seed_initial_dividends_progress(
    admin: CurrentUser = Depends(require_admin),
):
    """查询首跑播种运行进度（admin-only，与 POST 同权限）。

    返回进程内内存态进度（不入库、不跨进程）：state(idle|running|done|error|cancelled) /
    total / processed / hits / failed / covered / started_at / finished_at /
    error / message / failed_securities（失败证券清单，每条含 master_id/code/name，
    UI 展开查看「代码 + 名称」，上限见服务端 _FAILED_IDS_CAP，超出置 failed_truncated）/
    failed_truncated。前端据此轮询展示进度条、失败只数与失败证券清单；进程重启后归零为 idle。
    """
    from app.services.dividend_seed import seed_progress

    return {
        "state": seed_progress.state,
        "total": seed_progress.total,
        "processed": seed_progress.processed,
        "hits": seed_progress.hits,
        "failed": seed_progress.failed,
        "covered": seed_progress.covered,
        "started_at": seed_progress.started_at,
        "finished_at": seed_progress.finished_at,
        "error": seed_progress.error,
        "message": seed_progress.message,
        "failed_securities": seed_progress.failed_securities,
        "failed_truncated": seed_progress.failed_truncated,
    }


@router_trigger.post("/seed-initial-dividends/cancel")
async def cancel_seed_initial_dividends(
    admin: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """取消正在运行的历史分红播种（admin-only）。

    **两条取消路径**（缺一不可）：
    - **本进程**：握有 ``seed_task`` 时直接 ``task.cancel()``，协程在下一个 await 中断点
      （单只网络请求或 commit）抛 ``CancelledError`` 而停止。
    - **跨进程**：置 ``admin_locks.cancel_requested_at`` 标记。``seed_task`` 是进程内变量，
      多 worker 下任务若在别的进程则本进程拿不到引用（旧实现直接 409，用户点不动）；
      持锁 worker 的播种循环在每个检查点自检该标记后自行退出。

    **已完成部分保留**（按「当前明细源 + 近 5 年」判定为已覆盖），再次触发会从断点续跑，
    不丢数据、不重复写入。

    **单飞锁不在本端点释放**：取消信号传播后 ``_run_seed`` 的 ``finally`` 才释放
    ``_seed_lock`` 与 DB 锁，避免此处与 finally 重复释放导致竞态。

    **无运行任务 → 409**：DB 标记置位失败（无人持锁）**且** 本进程无运行中任务，即判定
    「无任务可取消」。仅置标记成功（任务在别的 worker）时返回 200。

    **幂等**：本进程任务已在取消中（``cancelling() > 0``，含「已收到取消、正在 finally
    释放锁」的窗口，此时 ``done()`` 仍为 False）时**不重复注入** ``task.cancel()``——二次
    注入会让 ``CancelledError`` 落在 ``_run_seed`` 的 ``finally`` 上，跳过进程内单飞锁的
    释放（详见 ``_run_seed`` 的说明）。此路径返回 200 + 提示，不报错。
    """
    global seed_task
    # ① 跨进程信号：置 DB 取消标记（不依赖本进程是否持有任务对象）。
    #    有人持锁 = 有任务在跑 → True；无人持锁 → False。
    marked = await request_cancel(db, LOCK_DIVIDEND_SEED)
    # ② 本进程快路径：握有任务对象时直接 cancel（协程在下一个 await 中断点停止）。
    local_running = seed_task is not None and not seed_task.done()
    if not marked and not local_running:
        raise BusinessException(
            code=BusinessErrorCode.VALIDATION_FAILED,
            message="当前没有正在运行的补齐历史分红任务",
            status_code=409,
        )
    from app.services.dividend_seed import seed_progress, _seed_progress_now

    if local_running:
        # 幂等去重（防二次注入）：任务已收到取消请求但尚未结束（含在 finally 中释放锁的
        # 窗口）时不重复 cancel——二次注入的 CancelledError 会落在 finally 的 await 上，
        # 使 _seed_lock.release() 被跳过（全仓唯一释放点，泄漏后只能重启恢复）。
        if seed_task.cancelling() > 0:
            return {"message": "取消信号已发送，任务正在停止"}
        seed_task.cancel()
        seed_progress.state = "cancelled"
        seed_progress.finished_at = _seed_progress_now()
        seed_progress.error = None
        seed_progress.message = "已由用户取消（已完成部分保留，可再次触发续跑）"
    # 仅置标记时（任务在其它 worker）不动本进程进度态——由持锁 worker 在检查点
    # 自检后置 cancelled，避免本进程拿一个并非自己任务的进度乱写。
    return {"message": "已发送取消信号，任务将在下一个中断点停止"}
