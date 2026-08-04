/**
 * 通用 API 类型定义
 *
 * API 响应信封：{ code: number, data: T, message: string }
 * - code === 0 表示成功
 * - code !== 0 表示错误，data 为 null，message 为错误描述
 *
 * 错误码规划：
 *   0           成功
 *   1000-1999   认证错误（1001=未认证, 1002=Token过期, 1003=邮箱已注册）
 *   1004=当前密码错误（使用 HTTP 400，避免前端拦截器误判为登录失效）
 *   1005        (预留，跳过不用)
 *   1006        文件校验失败（类型 / 大小 / 缺失，HTTP 400）—— 已被占用，勿复用
 *   1007        账户处于注销冷静期（HTTP 409 + data.remainingDays，SYS-P1-02）
 *   1008        账户未注销、无需恢复（HTTP 409，SYS-P1-02）
 *   1009        恢复期已过、数据不可找回（HTTP 410，SYS-P1-02）
 *   2000-2999   参数校验错误（2001=金额无效, 2002=日期无效, 2003=首笔必须买入）
 *   3000-3999   业务逻辑错误（3001=组合不存在, 3002=快照已存在, 3003=计算数据不足）
 *   4000-4999   计算错误（4001=XIRR不收敛, 4002=净值计算异常）
 *   5000        服务器内部错误
 */

/**
 * 统一 API 响应信封
 */
export interface ApiResponse<T = unknown> {
  /** 业务状态码，0 = 成功 */
  code: number;
  /** 响应数据，错误时为 null */
  data: T | null;
  /** 提示信息 */
  message: string;
}

/**
 * 分页响应结构
 */
export interface Paginated<T> {
  /** 数据列表 */
  items: T[];
  /** 总记录数 */
  total: number;
  /** 当前页码（从 1 开始） */
  page: number;
  /** 每页条数 */
  pageSize: number;
}

/**
 * 日期范围查询参数
 */
export interface DateRangeQuery {
  /** 起始日期 YYYY-MM-DD（含） */
  startDate?: string;
  /** 结束日期 YYYY-MM-DD（含） */
  endDate?: string;
}

/**
 * 分页查询参数
 */
export interface PaginationQuery {
  /** 页码，从 1 开始，默认 1 */
  page?: number;
  /** 每页条数，默认 20 */
  pageSize?: number;
}

/** 成功响应的默认 message */
export const SUCCESS_MESSAGE = 'success';

/** API 成功状态码 */
export const SUCCESS_CODE = 0;

/**
 * 业务错误码枚举（三端共用的单一事实来源）
 *
 * 用途：新代码统一引用本常量，避免继续散落魔法数字。
 * 注意：本次不改造既有硬编码（api-client.ts 的 UNAUTH_CODES、
 * http-exception.filter.ts 的 switch 等），避免无谓的回归面。
 */
export const BUSINESS_ERROR_CODE = {
  /** 成功 */
  SUCCESS: 0,
  /** 未认证（HTTP 401） */
  UNAUTHORIZED: 1001,
  /** Token 过期 / 无权限（HTTP 403） */
  TOKEN_EXPIRED: 1002,
  /** 邮箱已被注册（HTTP 409） */
  EMAIL_TAKEN: 1003,
  /** 当前密码错误（HTTP 400，刻意不用 401，避免前端拦截器把用户踢下线） */
  PASSWORD_WRONG: 1004,
  /** 文件校验失败：类型不符 / 超过大小上限 / 文件缺失（HTTP 400） */
  FILE_INVALID: 1006,
  /**
   * 账户处于注销冷静期（HTTP 409，响应 data 携带 { remainingDays }）。
   *
   * 刻意不用 401：前端 api-client 拦截器对任何 401 都会清 token +
   * 弹「登录已失效」+ 跳转登录页，冷静期信号会被当成失效踢走（SYS-P1-02）。
   */
  PENDING_DELETION: 1007,
  /** 账户未注销，无需恢复（HTTP 409，SYS-P1-02） */
  ACCOUNT_NOT_DELETED: 1008,
  /** 恢复期已过，账户数据已不可找回（HTTP 410，SYS-P1-02） */
  RESTORE_EXPIRED: 1009,
  /** 参数校验错误（HTTP 400） */
  VALIDATION_FAILED: 2000,
  /** 资源不存在（HTTP 404） */
  NOT_FOUND: 3001,
  /** 服务器内部错误（HTTP 500） */
  INTERNAL_ERROR: 5000,
} as const;

/** 业务错误码取值类型 */
export type BusinessErrorCode =
  (typeof BUSINESS_ERROR_CODE)[keyof typeof BUSINESS_ERROR_CODE];

// ==================== 账户注销 / 恢复（SYS-P1-02 · SET-P1-06） ====================

/**
 * 账户注销后的软删除保留期（冷静期）天数。
 *
 * 三端同源：后端 login/restore 判定、CleanupService 跑批、前端文案均引用本常量，
 * 避免「服务端 30 天、文案 15 天」这类不一致。
 */
export const ACCOUNT_RETENTION_DAYS = 30;

/** 账户注销后的软删除保留期（冷静期）毫秒数 = ACCOUNT_RETENTION_DAYS 天 */
export const ACCOUNT_RETENTION_MS = ACCOUNT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * 业务码 1007（账户处于注销冷静期）随响应 data 一并返回的结构。
 *
 * 前端直接展示 remainingDays，不得自行按 deletedAt 计算（PRD §7.10）。
 */
export interface AccountPendingDeletionData {
  /** 冷静期剩余天数，向上取整，取值区间 [1, ACCOUNT_RETENTION_DAYS] */
  remainingDays: number;
}
