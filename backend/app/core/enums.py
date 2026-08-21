"""业务错误码 — 与 app/packages/shared/src/types/api.ts 的 BUSINESS_ERROR_CODE 取值一致。

这是三端（旧 TS 后端 / 新 Python 后端 / Web）共用的单一事实来源在 Python 侧的镜像。
新增错误码必须与此文件及 shared 保持一致。
"""
from __future__ import annotations

from enum import Enum, IntEnum


class UserRole(str, Enum):
    """用户角色（RBAC 最小实现）。

    - USER：普通用户（默认）；
    - ADMIN：系统管理员（可访问 /api/admin 系统配置等受限端点）；
    - AUDITOR：审计只读角色（可查看日志中心等只读资源，不可写）。

    值以字符串落库（users.role 为 VARCHAR，非 PG 原生枚举），与 JWT payload 的
    role 字段同源。新增角色无需 DB 迁移（方案 §4.4）。
    """

    USER = "user"
    ADMIN = "admin"
    AUDITOR = "auditor"


class BusinessErrorCode(IntEnum):
    SUCCESS = 0
    # 认证 1001-1009
    UNAUTHORIZED = 1001          # 未认证（HTTP 401）
    TOKEN_EXPIRED = 1002         # Token 过期 / 无权限（HTTP 403）
    EMAIL_TAKEN = 1003           # 邮箱已被注册（HTTP 409）
    PASSWORD_WRONG = 1004        # 当前密码错误（HTTP 400，避免前端踢下线）
    FILE_INVALID = 1006          # 文件校验失败（HTTP 400）
    PENDING_DELETION = 1007      # 注销冷静期（HTTP 409 + data.remainingDays）
    ACCOUNT_NOT_DELETED = 1008   # 账户未注销（HTTP 409）
    RESTORE_EXPIRED = 1009       # 恢复期已过（HTTP 410）
    # 参数校验 2000-2999
    VALIDATION_FAILED = 2000     # 参数校验错误（HTTP 400）
    # 业务 3000-3999
    NOT_FOUND = 3001             # 资源不存在（HTTP 404）
    # 计算 4000-4999
    FORBIDDEN = 4001            # 权限不足（仅管理员可操作，HTTP 403）
    # 服务器 5000
    INTERNAL_ERROR = 5000        # 服务器内部错误（HTTP 500）


# HTTP 状态码 → 业务码 映射（无自定义 code 时使用），镜像 http-exception.filter.ts
HTTP_STATUS_TO_CODE: dict[int, int] = {
    400: BusinessErrorCode.VALIDATION_FAILED,
    401: BusinessErrorCode.UNAUTHORIZED,
    403: BusinessErrorCode.TOKEN_EXPIRED,
    404: BusinessErrorCode.NOT_FOUND,
    409: BusinessErrorCode.EMAIL_TAKEN,
    500: BusinessErrorCode.INTERNAL_ERROR,
}

# 业务码 → 默认 HTTP 状态码（service 主动抛 BusinessException 时若未显式指定则用此表）
CODE_TO_HTTP_STATUS: dict[int, int] = {
    BusinessErrorCode.UNAUTHORIZED: 401,
    BusinessErrorCode.TOKEN_EXPIRED: 403,
    BusinessErrorCode.EMAIL_TAKEN: 409,
    BusinessErrorCode.PASSWORD_WRONG: 400,
    BusinessErrorCode.FILE_INVALID: 400,
    BusinessErrorCode.PENDING_DELETION: 409,
    BusinessErrorCode.ACCOUNT_NOT_DELETED: 409,
    BusinessErrorCode.RESTORE_EXPIRED: 410,
    BusinessErrorCode.VALIDATION_FAILED: 400,
    BusinessErrorCode.NOT_FOUND: 404,
    BusinessErrorCode.FORBIDDEN: 403,
    BusinessErrorCode.INTERNAL_ERROR: 500,
}

ACCOUNT_RETENTION_DAYS = 30
