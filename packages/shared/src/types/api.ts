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
