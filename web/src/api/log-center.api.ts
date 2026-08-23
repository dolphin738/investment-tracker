/**
 * api/log-center.api.ts — 日志中心聚合查询 API（方案 §4.3 / §4.5）
 *
 * 对应后端 /api/admin/logs（聚合 app_logs + notifications + job_run_logs）：
 * - GET    /api/admin/logs           ：聚合分页列表（按 created_at 倒序）
 * - GET    /api/admin/logs/{log_id}  ：单条详情（含 trace，id 带来源前缀）
 * - DELETE /api/admin/logs           ：批量/单行删除（仅 admin）
 *
 * 读守卫 require_any_role('admin','auditor')；删除守卫 require_admin。
 * 前端菜单仅 admin/auditor 可见。
 */

import { http } from '@/lib/api-client';

/** 日志来源（id 前缀 app:/notif:/job: 解出的来源） */
export type LogSource = 'app' | 'notification' | 'job';

/** 日志级别（后端落库字符串透传） */
export type LogLevel = 'error' | 'warning' | 'info';

/** 日志作用域（app_logs.scope 透传；聚合后还可能出现 notification/job/client） */
export type LogScope =
  | 'operation'
  | 'error'
  | 'system'
  | 'client'
  | 'notification'
  | 'job';

/** 聚合后的统一日志条目（id 带来源前缀） */
export interface LogItem {
  id: string;
  source: LogSource;
  level: LogLevel | string | null;
  scope: LogScope | string | null;
  module: string | null;
  message: string | null;
  trace: string | null;
  detail: unknown | null;
  user_id: string | null;
  created_at: string;
  /** 仅 notification 源有意义：是否已读 */
  read: boolean | null;
}

/** 聚合列表查询参数（与后端 list_logs 一一对应） */
export interface LogListQuery {
  level?: LogLevel;
  scope?: LogScope;
  module?: string;
  /** ISO 日期时间或日期串（created_at >= start） */
  start?: string;
  /** ISO 日期时间或日期串（created_at <= end） */
  end?: string;
  keyword?: string;
  page?: number;
  pageSize?: number;
}

/** 聚合分页结果 */
export interface LogListOut {
  items: LogItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** 聚合日志列表 */
export function listLogs(query: LogListQuery = {}): Promise<LogListOut> {
  return http.get<LogListOut>('/admin/logs', { params: query });
}

/** 单条日志详情 */
export function getLog(logId: string): Promise<LogItem> {
  return http.get<LogItem>(`/admin/logs/${encodeURIComponent(logId)}`);
}

/** 批量/单行删除日志请求参数：
 *  - ids：指定 id 删除（与 all 互斥；all=true 时忽略）；
 *  - all=true：删除「当前筛选条件下全部日志」（跨所有页），并传回列表同款筛选条件。 */
export interface LogDeleteParams {
  ids?: string[];
  all?: boolean;
  level?: LogLevel;
  scope?: LogScope;
  module?: string;
  start?: string;
  end?: string;
  keyword?: string;
}

/** 批量/单行删除日志结果（DELETE /admin/logs） */
export interface LogDeleteResult {
  /** 实际删除的日志条数 */
  deleted: number;
  /** 被跳过的 id 及原因（不存在 / 未读通知） */
  skipped: { id: string; reason: string }[];
}

/** 批量/单行删除聚合日志（仅 admin；未读通知由后端跳过并计入 skipped） */
export function deleteLogs(params: LogDeleteParams = {}): Promise<LogDeleteResult> {
  return http.delete<LogDeleteResult>('/admin/logs', { data: params });
}
