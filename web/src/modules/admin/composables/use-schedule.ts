/**
 * modules/admin/composables/use-schedule.ts — 定时任务管理 vue-query hooks
 *
 * - useTasks：列出全部任务（含最近一次执行摘要）。
 * - useTaskHandlers：可新建任务类型清单（供新建表单渲染）。
 * - useCreateTask / useUpdateTask / useDeleteTask / useTriggerTask：写操作并在成功后失效列表。
 * - useTaskLogs：分页查询某任务执行日志（按触发来源/状态提供常量映射）。
 */

import { computed, toValue, type ComputedRef } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { toast } from '@/composables/use-toast';
import {
  createTask,
  deleteTask,
  listTaskHandlers,
  listTaskLogs,
  listTasks,
  triggerTask,
  updateTask,
  type JobKind,
  type JobRunStatus,
  type JobTaskType,
  type ScheduleTaskCreate,
  type ScheduleTaskUpdate,
  type TaskLogQuery,
} from '@/api/schedule.api';
import { useIsAdmin } from '@/stores/auth.store';

/** 任务列表 query key（供失效精确命中） */
export function tasksKey(): unknown[] {
  return ['admin', 'tasks'];
}

/** 列出全部任务；非管理员不发起请求 */
export function useTasks() {
  const isAdmin = useIsAdmin();
  return useQuery({
    queryKey: tasksKey(),
    queryFn: listTasks,
    enabled: isAdmin,
  });
}

/** 可新建任务类型清单；非管理员不发起请求 */
export function useTaskHandlers() {
  const isAdmin = useIsAdmin();
  return useQuery({
    queryKey: ['admin', 'task-handlers'],
    queryFn: listTaskHandlers,
    enabled: isAdmin,
  });
}

/** 分页查询某任务执行日志（taskId 为空时不发起请求） */
export function useTaskLogs(
  taskId: ComputedRef<string | null>,
  params: ComputedRef<TaskLogQuery>,
) {
  const isAdmin = useIsAdmin();
  return useQuery({
    queryKey: computed(() => [
      'admin',
      'task-logs',
      taskId.value ?? '',
      params.value.page ?? 1,
      params.value.pageSize ?? 20,
    ]),
    queryFn: () => listTaskLogs(taskId.value!, toValue(params)),
    enabled: isAdmin && Boolean(taskId.value),
  });
}

/** 新建普通任务 */
export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ScheduleTaskCreate) => createTask(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tasksKey() });
      toast.success('任务已创建');
    },
    onError: () => toast.error('创建失败，请检查任务配置'),
  });
}

/** 编辑任务（普通/系统均可） */
export function useUpdateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ScheduleTaskUpdate }) =>
      updateTask(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tasksKey() });
      toast.success('已保存');
    },
    onError: () => toast.error('保存失败，请检查任务配置'),
  });
}

/** 删除普通任务（系统任务由后端 400 拦截） */
export function useDeleteTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteTask(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tasksKey() });
      toast.success('已删除');
    },
    onError: () => toast.error('删除失败，请检查权限'),
  });
}

/** 手动立即执行一次 */
export function useTriggerTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => triggerTask(id),
    onSuccess: () => {
      toast.success('已触发执行，稍后刷新查看结果');
      queryClient.invalidateQueries({ queryKey: tasksKey() });
    },
    onError: () => toast.error('触发失败'),
  });
}

// ---------------------------------------------------------------------------
// 展示常量映射（中文标签 / 徽标样式）
// ---------------------------------------------------------------------------
/** 任务类型 → 中文标签 */
export const TASK_TYPE_LABEL: Record<JobTaskType, string> = {
  MARKET_DATA_SYNC: '行情同步',
  SECURITY_MASTER_SYNC: '证券主数据同步',
  LOCAL_COMMAND: '定时执行脚本',
  HTTP_CALLBACK: 'HTTP 回调',
  ACCOUNT_CLEANUP: '账户清理',
};

/** 任务归类 → 中文标签（SYSTEM 系统任务仅可编辑不可删除） */
export const TASK_KIND_LABEL: Record<JobKind, string> = {
  SYSTEM: '系统任务',
  NORMAL: '普通任务',
};

/** 归类徽标配色：系统任务主色、普通任务中性色 */
export const TASK_KIND_VARIANT: Record<JobKind, string> = {
  SYSTEM: 'default',
  NORMAL: 'secondary',
};

/** 最近执行状态徽标配色 */
export const RUN_STATUS_VARIANT: Record<JobRunStatus, string> = {
  RUNNING: 'default',
  SUCCESS: 'success',
  FAILED: 'destructive',
};

/** 触发来源 → 中文标签 */
export const TRIGGER_SOURCE_LABEL: Record<string, string> = {
  SCHEDULED: '定时触发',
  MANUAL: '手动执行',
};