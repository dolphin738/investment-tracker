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
from sqlalchemy import bindparam, select, text
from sqlalchemy import DateTime, Integer, String
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.envelope import EnvelopeRoute
from app.core.security import CurrentUser, require_any_role
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
