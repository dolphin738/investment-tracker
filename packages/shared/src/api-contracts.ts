/**
 * API 契约类型定义
 *
 * 通用响应信封、分页、日期范围查询等跨模块契约。
 * 对齐 ARCH §4.1 通用约定与 §5.2 响应结构。
 */

// ==================== 通用响应信封 ====================

/** 统一 API 响应信封 */
export interface ApiResponse<T = unknown> {
  /** 业务状态码，0 表示成功 */
  code: number;
  /** 响应数据 */
  data: T;
  /** 提示信息 */
  message: string;
}

// ==================== 分页 ====================

/** 分页请求参数 */
export interface PaginationQuery {
  /** 页码，从 1 开始 */
  page?: number;
  /** 每页条数，默认 20 */
  pageSize?: number;
}

/** 分页响应 */
export interface Paginated<T> {
  /** 当前页数据列表 */
  items: T[];
  /** 总条数 */
  total: number;
  /** 当前页码 */
  page: number;
  /** 每页条数 */
  pageSize: number;
}

// ==================== 日期范围查询 ====================

/** 日期范围查询参数 */
export interface DateRangeQuery {
  /** 开始日期 YYYY-MM-DD（可选） */
  startDate?: string;
  /** 结束日期 YYYY-MM-DD（可选） */
  endDate?: string;
}
