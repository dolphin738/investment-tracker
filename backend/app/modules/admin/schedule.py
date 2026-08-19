"""管理员定时任务路由 — 数据库驱动统一调度器（job_configs / job_run_logs）。

对应定时任务管理页：
- GET    /api/admin/tasks：列出全部任务（含最近一次执行摘要）。
- GET    /api/admin/tasks/handlers：可新建任务类型清单（含参数表单元数据）。
- POST   /api/admin/tasks：新建普通任务（kind=NORMAL 可增删；系统任务不可新建）。
- PATCH  /api/admin/tasks/{id}：编辑任务（普通任务可改 cron/启停/参数/类型；系统任务仅可编辑 cron/启停/参数/名称，类型与归类只读）。
- DELETE /api/admin/tasks/{id}：删除任务（仅普通任务；系统任务 → 400）。
- POST   /api/admin/tasks/{id}/trigger：手动立即执行一次。
- GET    /api/admin/tasks/{id}/logs：分页查询执行日志。

权限：全部依赖 require_admin；系统任务「仅可编辑不可删除」在服务层/路由层强制。
每次增删改后调用 ``reload_schedule`` 使调度与库保持一致。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import paginate
from app.core.envelope import EnvelopeRoute
from app.core.scheduler import reload_schedule, run_task_now
from app.core.security import CurrentUser, get_current_user, require_admin
from app.db.database import get_db
from app.models import JobConfig, JobRunLog
from app.models.enums import JobKind, JobTaskType

router_admin_schedule = APIRouter(
    prefix="/api/admin/tasks", tags=["admin"], route_class=EnvelopeRoute
)

# 任务类型 → UI 元数据（label / 是否可新建 / 参数表单字段说明）
_HANDLER_META: dict[JobTaskType, dict[str, Any]] = {
    JobTaskType.SECURITY_MASTER_SYNC: {
        "label": "证券主数据同步",
        "creatable": True,
        "param_fields": [],
    },
    JobTaskType.LOCAL_COMMAND: {
        "label": "定时执行脚本",
        "creatable": True,
        "param_fields": [
            {"key": "command", "label": "命令", "required": True, "type": "text"},
        ],
    },
    JobTaskType.HTTP_CALLBACK: {
        "label": "HTTP 回调",
        "creatable": True,
        "param_fields": [
            {"key": "url", "label": "URL", "required": True, "type": "text"},
            {"key": "method", "label": "方法", "required": False, "type": "text", "default": "POST"},
            {"key": "body", "label": "JSON 请求体", "required": False, "type": "json"},
        ],
    },
    JobTaskType.ACCOUNT_CLEANUP: {
        "label": "账户清理",
        "creatable": False,
        "param_fields": [],
    },
}

# 系统任务仅由迁移种子写入，不提供新建入口
_CREATABLE_TYPES = [t for t, m in _HANDLER_META.items() if m["creatable"]]


# --------------------------------------------------------------------------- #
# 内联 schema
# --------------------------------------------------------------------------- #
def _validate_cron(cron_expr: str) -> None:
    """校验 5 字段 cron 表达式可被 APScheduler 解析，非法 → HTTP 400。"""
    try:
        from apscheduler.triggers.cron import CronTrigger

        CronTrigger.from_crontab(cron_expr)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"cron 表达式非法：{exc}") from exc


class JobCreate(BaseModel):
    name: str
    task_type: JobTaskType
    cron_expr: str
    enabled: bool = False
    params: Optional[dict[str, Any]] = None
    description: Optional[str] = None


class JobUpdate(BaseModel):
    name: Optional[str] = None
    # 任务类型：普通任务可改；系统任务不可改（路由层按 kind 拦截）。
    task_type: Optional[JobTaskType] = None
    cron_expr: Optional[str] = None
    enabled: Optional[bool] = None
    params: Optional[dict[str, Any]] = None
    description: Optional[str] = None


class JobOut(BaseModel):
    id: str
    name: str
    task_type: str
    kind: str
    enabled: bool
    cron_expr: str
    params: Optional[dict[str, Any]]
    description: Optional[str]
    created_at: datetime
    updated_at: datetime
    # 最近一次执行摘要（列表端点陪齐）
    last_run_at: Optional[datetime] = None
    last_run_status: Optional[str] = None
    last_run_message: Optional[str] = None
    last_run_error: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)


class JobRunLogOut(BaseModel):
    id: str
    job_id: str
    status: str
    trigger_source: str
    started_at: datetime
    finished_at: Optional[datetime]
    message: Optional[str]
    error: Optional[str]

    model_config = ConfigDict(from_attributes=True)


class JobHandlerOut(BaseModel):
    task_type: str
    label: str
    creatable: bool
    param_fields: list[dict[str, Any]]


@router_admin_schedule.get("/handlers")
async def list_task_handlers(
    current: CurrentUser = Depends(require_admin),
) -> list[JobHandlerOut]:
    """可新建任务类型清单（供前端表单渲染类型选择与参数字段）。"""
    return [
        JobHandlerOut(
            task_type=t.value,
            label=m["label"],
            creatable=m["creatable"],
            param_fields=m["param_fields"],
        )
        for t, m in _HANDLER_META.items()
    ]


async def _latest_log_map(db: AsyncSession, job_ids: list[str]) -> dict[str, JobRunLog]:
    """一次查询取全部任务最近一条执行日志（id → log），供列表陪齐摘要。"""
    if not job_ids:
        return {}
    rows = (
        await db.execute(
            select(JobRunLog)
            .where(JobRunLog.job_id.in_(job_ids))
            .order_by(JobRunLog.started_at.desc())
        )
    ).scalars().all()
    latest: dict[str, JobRunLog] = {}
    for log in rows:
        latest.setdefault(log.job_id, log)
    return latest


@router_admin_schedule.get("")
async def list_tasks(
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[JobOut]:
    """列出全部任务（含最近一次执行摘要，按创建时间升序）。"""
    configs = (
        await db.execute(select(JobConfig).order_by(JobConfig.created_at.asc()))
    ).scalars().all()
    latest = await _latest_log_map(db, [c.id for c in configs])
    items: list[JobOut] = []
    for c in configs:
        out = JobOut.model_validate(c)
        log = latest.get(c.id)
        if log is not None:
            out.last_run_at = log.started_at
            out.last_run_status = log.status.value
            out.last_run_message = log.message
            out.last_run_error = log.error
        items.append(out)
    return items


@router_admin_schedule.post("")
async def create_task(
    body: JobCreate,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> JobOut:
    """新建普通任务（系统任务不可新建）。"""
    if body.task_type not in _CREATABLE_TYPES:
        raise HTTPException(status_code=400, detail="该任务类型为系统任务，不可新建")
    _validate_cron(body.cron_expr)
    existing = (
        await db.execute(select(JobConfig).where(JobConfig.name == body.name))
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=400, detail="任务名称已存在")
    cfg = JobConfig(
        name=body.name,
        task_type=body.task_type,
        kind=JobKind.NORMAL,
        enabled=body.enabled,
        cron_expr=body.cron_expr,
        params=body.params,
        description=body.description,
    )
    db.add(cfg)
    await db.commit()
    await db.refresh(cfg)
    await reload_schedule()
    return JobOut.model_validate(cfg)


@router_admin_schedule.patch("/{task_id}")
async def update_task(
    task_id: str,
    body: JobUpdate,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> JobOut:
    """编辑任务（普通/系统均可；系统任务仅可编辑 cron/启停/参数/名称，不可改类型/归类）。"""
    cfg = await db.get(JobConfig, task_id)
    if cfg is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    if body.name is not None:
        dup = (
            await db.execute(
                select(JobConfig).where(
                    JobConfig.name == body.name, JobConfig.id != task_id
                )
            )
        ).scalar_one_or_none()
        if dup is not None:
            raise HTTPException(status_code=400, detail="任务名称已存在")
        cfg.name = body.name
    if body.task_type is not None:
        if cfg.kind == JobKind.SYSTEM:
            raise HTTPException(status_code=400, detail="系统任务类型不可修改")
        if body.task_type not in _CREATABLE_TYPES:
            raise HTTPException(status_code=400, detail="该任务类型为系统任务，不可设置")
        cfg.task_type = body.task_type
    if body.cron_expr is not None:
        _validate_cron(body.cron_expr)
        cfg.cron_expr = body.cron_expr
    if body.enabled is not None:
        cfg.enabled = body.enabled
    if body.params is not None:
        cfg.params = body.params
    if body.description is not None:
        cfg.description = body.description
    await db.commit()
    await db.refresh(cfg)
    await reload_schedule()
    return JobOut.model_validate(cfg)


@router_admin_schedule.delete("/{task_id}")
async def delete_task(
    task_id: str,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """删除普通任务；系统任务仅可编辑不可删除 → 400。"""
    cfg = await db.get(JobConfig, task_id)
    if cfg is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    if cfg.kind == JobKind.SYSTEM:
        raise HTTPException(status_code=400, detail="系统任务仅可编辑，不可删除")
    await db.delete(cfg)
    await db.commit()
    await reload_schedule()
    return {"id": task_id, "deleted": True}


@router_admin_schedule.post("/{task_id}/trigger")
async def trigger_task(
    task_id: str,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """手动立即执行一次（写入 MANUAL 来源的执行日志）。"""
    cfg = await db.get(JobConfig, task_id)
    if cfg is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    run_task_now(task_id)
    return {"id": task_id, "triggered": True}


@router_admin_schedule.get("/{task_id}/logs")
async def list_task_logs(
    task_id: str,
    page: int = Query(1, ge=1),
    pageSize: int = Query(20, ge=1, le=200),
    current: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """分页查询任务执行日志（按开始时间倒序）。"""
    cfg = await db.get(JobConfig, task_id)
    if cfg is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    stmt = (
        select(JobRunLog)
        .where(JobRunLog.job_id == task_id)
        .order_by(JobRunLog.started_at.desc())
    )
    return await paginate(db, stmt, page, pageSize, lambda r: JobRunLogOut.model_validate(r).model_dump())