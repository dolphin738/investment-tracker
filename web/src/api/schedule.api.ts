/**
 * api/schedule.api.ts — 定时任务管理 API（统一 APScheduler 调度器）
 *
 * 对应后端 modules/admin/schedule.py（前缀 /api/admin/tasks，http 客户端已解包信封）：
 * - GET    /admin/tasks：列出全部任务（含最近一次执行摘要）
 * - GET    /admin/tasks/handlers：可新建任务类型清单（含参数字段元数据）
 * - POST   /admin/tasks：新建普通任务（kind=SYSTEM 不可新建）
 * - PATCH  /admin/tasks/{id}：编辑任务（普通/系统均可；系统任务仅可编辑不可删除）
 * - DELETE /admin/tasks/{id}：删除普通任务（系统任务 400）
 * - POST   /admin/tasks/{id}/trigger：手动立即执行一次
 * - GET    /admin/tasks/{id}/logs：分页查询执行日志
 */

import { http } from '@/lib/api-client';
import type { PaginatedResponse } from './types';

/** 任务类型（后端 JobTaskType 枚举值，str 语义） */
export type JobTaskType =
  | 'MARKET_DATA_SYNC'
  | 'SECURITY_MASTER_SYNC'
  | 'LOCAL_COMMAND'
  | 'HTTP_CALLBACK'
  | 'ACCOUNT_CLEANUP';

/** 任务归类（后端 JobKind）：SYSTEM 仅可编辑不可删除；NORMAL 可增删改 */
export type JobKind = 'SYSTEM' | 'NORMAL';

/** 单次执行状态（后端 JobRunStatus） */
export type JobRunStatus = 'RUNNING' | 'SUCCESS' | 'FAILED';

/** 触发来源（后端 JobTriggerSource） */
export type JobTriggerSource = 'SCHEDULED' | 'MANUAL';

/** 任务配置行（后端 JobOut，snake_case 与后端一致） */
export interface ScheduleTask {
  id: string;
  name: string;
  task_type: JobTaskType;
  kind: JobKind;
  enabled: boolean;
  cron_expr: string;
  params: Record<string, unknown> | null;
  description: string | null;
  /** 保留执行日志条数上限（null/<=0 表示不限制） */
  max_logs: number | null;
  created_at: string;
  updated_at: string;
  /** 最近一次执行时间（无执行记录为 null） */
  last_run_at: string | null;
  last_run_status: JobRunStatus | null;
  last_run_message: string | null;
  last_run_error: string | null;
}

/** 任务类型 handler 元数据（供新建表单渲染类型选择与参数字段） */
export interface JobHandler {
  task_type: JobTaskType;
  label: string;
  creatable: boolean;
  param_fields: {
    key: string;
    label: string;
    required: boolean;
    type: string;
    default?: unknown;
  }[];
}

/** 新建普通任务请求体 */
export interface ScheduleTaskCreate {
  name: string;
  task_type: JobTaskType;
  cron_expr: string;
  enabled?: boolean;
  params?: Record<string, unknown>;
  description?: string;
  /** 保留执行日志条数上限（缺省/<=0 表示不限制） */
  max_logs?: number | null;
}

/** 编辑任务请求体（一切字段可选；kind 不可改；普通任务可改 task_type，系统任务不可改） */
export interface ScheduleTaskUpdate {
  name?: string;
  task_type?: JobTaskType;
  cron_expr?: string;
  enabled?: boolean;
  params?: Record<string, unknown> | null;
  description?: string;
  /** 保留执行日志条数上限（null/<=0 表示不限制） */
  max_logs?: number | null;
}

/** 单条执行日志行（后端 JobRunLogOut） */
export interface TaskLog {
  id: string;
  job_id: string;
  status: JobRunStatus;
  trigger_source: JobTriggerSource;
  started_at: string;
  finished_at: string | null;
  message: string | null;
  error: string | null;
}

/** 执行日志分页查询参数 */
export interface TaskLogQuery {
  page?: number;
  pageSize?: number;
}

/** 列出全部任务（含最近一次执行摘要） */
export function listTasks(): Promise<ScheduleTask[]> {
  return http.get<ScheduleTask[]>('/admin/tasks');
}

/** 可新建任务类型清单 */
export function listTaskHandlers(): Promise<JobHandler[]> {
  return http.get<JobHandler[]>('/admin/tasks/handlers');
}

/** 新建普通任务 */
export function createTask(body: ScheduleTaskCreate): Promise<ScheduleTask> {
  return http.post<ScheduleTask>('/admin/tasks', body);
}

/** 编辑任务（普通/系统均可） */
export function updateTask(
  id: string,
  body: ScheduleTaskUpdate,
): Promise<ScheduleTask> {
  return http.patch<ScheduleTask>(`/admin/tasks/${id}`, body);
}

/** 删除普通任务（系统任务后端返回 400） */
export function deleteTask(id: string): Promise<{ id: string; deleted: boolean }> {
  return http.delete<{ id: string; deleted: boolean }>(`/admin/tasks/${id}`);
}

/** 手动立即执行一次 */
export function triggerTask(id: string): Promise<{ id: string; triggered: boolean }> {
  return http.post<{ id: string; triggered: boolean }>(`/admin/tasks/${id}/trigger`);
}

/** 分页查询任务执行日志 */
export function listTaskLogs(
  id: string,
  params: TaskLogQuery = {},
): Promise<PaginatedResponse<TaskLog>> {
  const query: Record<string, unknown> = {};
  if (params.page != null) query.page = params.page;
  if (params.pageSize != null) query.pageSize = params.pageSize;
  return http.get<PaginatedResponse<TaskLog>>(`/admin/tasks/${id}/logs`, {
    params: query,
  });
}