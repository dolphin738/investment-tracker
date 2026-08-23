"""管理员日志中心 — 聚合查询 API（方案 §4.3 / §4.5 / §7.3-3）。

把 ``app_logs`` / ``notifications`` / ``job_run_logs`` 三源归一为统一 ``LogItem``：
- 单条 UNION ALL CTE 完成三源拼接，再在统一列上做过滤 + 排序 + 分页（§7.3-3 硬规则：
  绝不能三源各查一页再拼，会破坏排序与分页）。
- 三源 id 用**前缀**区分：``app:<uuid>`` / ``notif:<uuid>`` / ``job:<uuid>``；
  详情端点解析前缀后查对应源返回完整 LogItem（含 trace）。

权限：读守卫 ``require_any_role("admin", "auditor")``（Task #1 已加）；
写操作（若后续加）用 ``require_admin``。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import bindparam, delete, select, text
from sqlalchemy import DateTime, Integer, String
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.envelope import EnvelopeRoute
from app.core.security import CurrentUser, require_admin, require_any_role
from app.db.database import get_db
from app.models.job import JobConfig, JobRunLog
from app.models.log import AppLog
from app.models.notification import Notification

router_admin_log_center = APIRouter(
    prefix="/api/admin/logs", tags=["admin"], route_class=EnvelopeRoute
)


# --------------------------------------------------------------------------- #
# 三源归一 CTE（统一列：id, source, level, scope, module, message, trace,
# detail, user_id, created_at, read）
# --------------------------------------------------------------------------- #
_CTE_INNER = """
SELECT
    a.id AS id, 'app' AS source, a.level AS level, a.scope AS scope,
    a.module AS module, a.message AS message, a.trace AS trace,
    a.detail AS detail, a.user_id AS user_id, a.created_at AS created_at,
    NULL::boolean AS read
FROM app_logs a
UNION ALL
SELECT
    n.id, 'notification', n.level, 'notification', 'notification',
    n.message, NULL, NULL, NULL, n.created_at, n.read
FROM notifications n
UNION ALL
SELECT
    jrl.id, 'job',
    CASE WHEN jrl.error IS NOT NULL THEN 'error' ELSE 'info' END,
    'job', COALESCE(jc.name, 'scheduler'),
    COALESCE(jrl.message, jrl.status::text), jrl.error, NULL, NULL,
    jrl.started_at, NULL
FROM job_run_logs jrl
LEFT JOIN job_configs jc ON jc.id = jrl.job_id
"""

# 统一列上的过滤（level/scope/module 三源共用同一列，§7.3-3 推荐写法）
_FILTER_WHERE = """
WHERE (:level IS NULL OR level = :level)
  AND (:scope IS NULL OR scope = :scope)
  AND (:module IS NULL OR module = :module)
  AND (:start IS NULL OR created_at >= :start)
  AND (:end IS NULL OR created_at <= :end)
  AND (:keyword IS NULL OR message ILIKE :keyword)
"""

# 显式声明过滤参数类型：当所有参数均为 NULL 时，asyncpg 在 prepare 阶段无法从
# 字面量推断 $N 类型（AmbiguousParameterError → 全请求 500）。用 bindparam 给定
# 类型后，即使全 NULL 也能正确编译。start/end 声明为 DateTime 以匹配 timestamptz 列。
_FILTER_BINDPARAMS = [
    bindparam("level", type_=String),
    bindparam("scope", type_=String),
    bindparam("module", type_=String),
    bindparam("start", type_=DateTime(timezone=True)),
    bindparam("end", type_=DateTime(timezone=True)),
    bindparam("keyword", type_=String),
]


# --------------------------------------------------------------------------- #
# schema
# --------------------------------------------------------------------------- #
class LogItem(BaseModel):
    """三源归一后的统一日志条目（id 带来源前缀）。"""

    id: str
    source: Literal["app", "notification", "job"]
    level: Optional[str] = None
    scope: Optional[str] = None
    module: Optional[str] = None
    message: Optional[str] = None
    trace: Optional[str] = None
    detail: Optional[Any] = None
    user_id: Optional[str] = None
    created_at: datetime
    read: Optional[bool] = None


class LogListOut(BaseModel):
    """聚合分页结果。"""

    items: list[LogItem]
    total: int
    page: int
    pageSize: int


class LogDeleteBody(BaseModel):
    """删除日志请求体。
    - ids：待删除日志 id 列表（带来源前缀 app:/notif:/job:）；all=False 时必填，可含重复，后端去重。
    - all=True：删除「当前筛选条件下全部日志」（跨所有页），忽略 ids；
      level/scope/module/start/end/keyword 与列表端点一致，用于定位目标集合。
    """

    ids: list[str] = []
    all: bool = False
    level: Optional[str] = None
    scope: Optional[str] = None
    module: Optional[str] = None
    start: Optional[str] = None
    end: Optional[str] = None
    keyword: Optional[str] = None


def _build_items(rows: list[dict]) -> list[LogItem]:
    """把 CTE 结果行组装为带前缀 id 的 LogItem 列表。"""
    items: list[LogItem] = []
    for r in rows:
        items.append(
            LogItem(
                id=f"{r['source']}:{r['id']}",
                source=r["source"],
                level=r["level"],
                scope=r["scope"],
                module=r["module"],
                message=r["message"],
                trace=r["trace"],
                detail=r["detail"],
                user_id=r["user_id"],
                created_at=r["created_at"],
                read=r["read"],
            )
        )
    return items


# --------------------------------------------------------------------------- #
# 聚合查询端点
# --------------------------------------------------------------------------- #
@router_admin_log_center.get("")
async def list_logs(
    level: Optional[str] = Query(None, pattern="^(error|warning|info)$"),
    scope: Optional[str] = Query(None, pattern="^(operation|error|system)$"),
    module: Optional[str] = Query(None),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    keyword: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    pageSize: int = Query(20, ge=1, le=200),
    current: CurrentUser = Depends(require_any_role("admin", "auditor")),
    db: AsyncSession = Depends(get_db),
) -> LogListOut:
    """聚合查询日志中心（三源归一，按 created_at 倒序分页）。

    level/scope/module 精确匹配；keyword ILIKE 命中 message；start/end 为
    created_at 区间（ISO 字符串）。
    """
    # start/end 为 ISO 字符串，解析为 datetime 再绑定：created_at 是 timestamptz 列，
    # 与 datetime 对象比较 PG 自动按 timestamptz 处理。直接用字符串会因类型不匹配
    # 触发隐式转换失败；且 _FILTER_WHERE 内不得写 `::timestamptz`（与 SQLAlchemy
    # text() 的 :param 绑定解析冲突，会残留 `:` 导致 asyncpg 语法错误 → 全请求 500）。
    def _parse_dt(v: Optional[str]) -> Optional[datetime]:
        if not v:
            return None
        try:
            return datetime.fromisoformat(v)
        except ValueError:
            return None

    filter_params: dict[str, Any] = {
        "level": level,
        "scope": scope,
        "module": module,
        "start": _parse_dt(start),
        "end": _parse_dt(end),
        "keyword": f"%{keyword}%" if keyword else None,
    }
    list_stmt = text(
        f"WITH cte AS ({_CTE_INNER}) "
        f"SELECT id, source, level, scope, module, message, trace, detail, "
        f"user_id, created_at, read FROM cte {_FILTER_WHERE} "
        f"ORDER BY created_at DESC LIMIT :limit OFFSET :offset"
    ).bindparams(
        *_FILTER_BINDPARAMS,
        bindparam("limit", type_=Integer),
        bindparam("offset", type_=Integer),
    )
    count_stmt = text(
        f"WITH cte AS ({_CTE_INNER}) SELECT count(*) AS cnt FROM cte {_FILTER_WHERE}"
    ).bindparams(*_FILTER_BINDPARAMS)
    list_params = {**filter_params, "limit": pageSize, "offset": (page - 1) * pageSize}

    total = (await db.execute(count_stmt, filter_params)).scalar_one()
    rows = (await db.execute(list_stmt, list_params)).mappings().all()
    return LogListOut(
        items=_build_items(rows),
        total=int(total),
        page=page,
        pageSize=pageSize,
    )


@router_admin_log_center.get("/{log_id}")
async def get_log(
    log_id: str,
    current: CurrentUser = Depends(require_any_role("admin", "auditor")),
    db: AsyncSession = Depends(get_db),
) -> LogItem:
    """日志详情：解析 ``<source>:<uuid>`` 前缀后查对应源，返回完整 LogItem（含 trace）。"""
    if ":" in log_id:
        source, raw_id = log_id.split(":", 1)
    else:
        source, raw_id = "app", log_id

    if source == "app":
        row = (
            await db.execute(select(AppLog).where(AppLog.id == raw_id))
        ).scalar_one_or_none()
        if row is None:
            raise HTTPException(status_code=404, detail="日志不存在")
        return LogItem(
            id=log_id,
            source="app",
            level=row.level,
            scope=row.scope,
            module=row.module,
            message=row.message,
            trace=row.trace,
            detail=row.detail,
            user_id=row.user_id,
            created_at=row.created_at,
        )

    if source == "notification":
        row = (
            await db.execute(select(Notification).where(Notification.id == raw_id))
        ).scalar_one_or_none()
        if row is None:
            raise HTTPException(status_code=404, detail="日志不存在")
        return LogItem(
            id=log_id,
            source="notification",
            level=row.level,
            scope="notification",
            module="notification",
            message=row.message,
            trace=None,
            detail=None,
            user_id=None,
            created_at=row.created_at,
            read=row.read,
        )

    if source == "job":
        row = (
            await db.execute(
                select(JobRunLog, JobConfig.name)
                .join(JobConfig, JobConfig.id == JobRunLog.job_id, isouter=True)
                .where(JobRunLog.id == raw_id)
            )
        ).first()
        if row is None:
            raise HTTPException(status_code=404, detail="日志不存在")
        run_log, cfg_name = row
        return LogItem(
            id=log_id,
            source="job",
            level="error" if run_log.error else "info",
            scope="job",
            module=cfg_name or "scheduler",
            message=run_log.message or run_log.status.value,
            trace=run_log.error,
            detail=None,
            user_id=None,
            created_at=run_log.started_at,
        )

    raise HTTPException(status_code=404, detail="日志不存在")


def _parse_dt(v: Optional[str]) -> Optional[datetime]:
    """把 ISO 字符串解析为 datetime，非法输入返回 None（与 list_logs 内解析逻辑一致）。"""
    if not v:
        return None
    try:
        return datetime.fromisoformat(v)
    except ValueError:
        return None


@router_admin_log_center.delete("")
async def delete_logs(
    body: LogDeleteBody,
    current: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """删除日志（三源归一，按来源分桶）。

    删除权限仅限 admin（``require_admin``）：非管理员 → 403，未登录 → 401。

    单事务（结尾仅一处 ``await db.commit()``）：
    - 默认（``all=False``）：按请求体传入的 ``ids`` 删除（带来源前缀，去重后逐个校验）；
      来源非法 / 不存在 / 未读通知 → 计入 skipped。
    - ``all=True``：用 ``_CTE_INNER``/``_FILTER_WHERE``/``_FILTER_BINDPARAMS`` 并复用列表
      筛选逻辑取「当前筛选条件下全部匹配 id」（跨所有页），忽略 ``ids``；该模式候选 id
      全部来自数据库，天然存在，skipped 仅含未读通知。
    - 硬规则：未读通知（source=notification 且 read IS FALSE）一律跳过，仅删已读通知，
      绝不波及用户未读消息。

    返回 ``{deleted, skipped}``；skipped 每项 ``{id, reason}``。
    """
    # 1) 定位候选 id 并按来源分桶
    app_ids: list[str] = []
    notif_ids: list[str] = []
    job_ids: list[str] = []
    skipped: list[dict[str, str]] = []

    if body.all:
        filter_params: dict[str, Any] = {
            "level": body.level,
            "scope": body.scope,
            "module": body.module,
            "start": _parse_dt(body.start),
            "end": _parse_dt(body.end),
            "keyword": f"%{body.keyword}%" if body.keyword else None,
        }
        # 仅取 source + id（不带 read）：未读通知统一在 notification 分桶时判定
        rows = (
            await db.execute(
                text(
                    f"WITH cte AS ({_CTE_INNER}) "
                    f"SELECT source, id FROM cte {_FILTER_WHERE}"
                ).bindparams(*_FILTER_BINDPARAMS),
                filter_params,
            )
        ).mappings().all()
        for r in rows:
            if r["source"] == "app":
                app_ids.append(r["id"])
            elif r["source"] == "notification":
                notif_ids.append(r["id"])
            else:
                job_ids.append(r["id"])
    else:
        if not body.ids:
            raise HTTPException(status_code=400, detail="ids 不能为空或格式非法")
        for i in list(dict.fromkeys(body.ids)):
            # id 带来源前缀，无冒号时按 get_log 语义视为 app；前缀非三源之一 → 来源非法
            if ":" in i:
                source, raw_id = i.split(":", 1)
            else:
                source, raw_id = "app", i
            if source not in ("app", "notif", "job"):
                skipped.append({"id": i, "reason": "来源非法"})
                continue
            if source == "app":
                app_ids.append(raw_id)
            elif source == "notif":
                notif_ids.append(raw_id)
            else:
                job_ids.append(raw_id)

    deleted = 0

    # 2) app 源：存在即删
    if app_ids:
        existing_app = set(
            (await db.execute(select(AppLog.id).where(AppLog.id.in_(app_ids))))
            .scalars()
            .all()
        )
        for i in app_ids:
            if i not in existing_app:
                skipped.append({"id": f"app:{i}", "reason": "日志不存在"})
        deletable_app = [i for i in app_ids if i in existing_app]
        if deletable_app:
            await db.execute(delete(AppLog).where(AppLog.id.in_(deletable_app)))
        deleted += len(deletable_app)

    # 3) job 源：存在即删
    if job_ids:
        existing_job = set(
            (await db.execute(select(JobRunLog.id).where(JobRunLog.id.in_(job_ids))))
            .scalars()
            .all()
        )
        for i in job_ids:
            if i not in existing_job:
                skipped.append({"id": f"job:{i}", "reason": "日志不存在"})
        deletable_job = [i for i in job_ids if i in existing_job]
        if deletable_job:
            await db.execute(delete(JobRunLog).where(JobRunLog.id.in_(deletable_job)))
        deleted += len(deletable_job)

    # 4) notification 源：仅删已读通知；不存在 / 未读一律跳过（硬规则）
    if notif_ids:
        notif_rows = dict(
            (
                await db.execute(
                    select(Notification.id, Notification.read).where(
                        Notification.id.in_(notif_ids)
                    )
                )
            ).all()
        )
        deletable_notif: list[str] = []
        for i in notif_ids:
            if i not in notif_rows:
                skipped.append({"id": f"notif:{i}", "reason": "日志不存在"})
            elif notif_rows[i] is False:
                skipped.append({"id": f"notif:{i}", "reason": "未读通知不可删除"})
            else:
                deletable_notif.append(i)
        if deletable_notif:
            await db.execute(
                delete(Notification).where(Notification.id.in_(deletable_notif))
            )
        deleted += len(deletable_notif)

    await db.commit()
    return {"deleted": deleted, "skipped": skipped}
