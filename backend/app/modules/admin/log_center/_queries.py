"""日志中心三源归一 CTE 与过滤片段（供 list_logs / delete_logs 共用）。

把 ``app_logs`` / ``notifications`` / ``job_run_logs`` 三源归一为统一列
（id, source, level, scope, module, message, trace, detail, user_id, created_at, read），
再在统一列上做过滤 + 排序 + 分页（§7.3-3 硬规则：绝不能三源各查一页再拼）。
"""
from __future__ import annotations

from sqlalchemy import DateTime, String, bindparam

# 三源归一 CTE（统一列：id, source, level, scope, module, message, trace,
# detail, user_id, created_at, read）
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
