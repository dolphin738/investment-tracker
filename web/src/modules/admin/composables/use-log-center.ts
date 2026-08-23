/**
 * modules/admin/composables/use-log-center.ts — 日志中心 vue-query hooks
 *
 * 对应后端 /api/admin/logs：
 * - useLogCenter：聚合列表（受 useHasRole('admin','auditor') 门控 enabled）
 * - useLogDetail：单条详情（详情弹窗用，logId 非空时发起）
 * - useDeleteLogs：批量/单行删除（仅 admin，mutationFn 传参；toast 交给调用组件区分提示）
 */

import { computed, type Ref } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  deleteLogs,
  getLog,
  listLogs,
  type LogDeleteParams,
  type LogItem,
  type LogListOut,
  type LogListQuery,
} from '@/api/log-center.api';
import { toast } from '@/composables/use-toast';
import { useHasRole } from '@/stores/auth.store';

/** 查询 key（与 useLogCenter / useLogDetail 共享） */
export const LOG_CENTER_KEY = ['admin', 'log-center'] as const;

/** 聚合日志列表（query 为响应式查询参数；角色不符时不发起） */
export function useLogCenter(query: Ref<LogListQuery>) {
  const canView = useHasRole('admin', 'auditor');
  // queryKey 用 computed 包装：在内部 effect 中求值 query.value，筛选/翻页变化时才能重建 key 触发重新请求
  const queryKey = computed(() => [...LOG_CENTER_KEY, query.value]);
  return useQuery({
    queryKey,
    queryFn: () => listLogs(query.value),
    enabled: canView,
    // 翻页/筛选时保留上一页数据，避免闪烁（vue-query v5 placeholderData）
    placeholderData: (prev) => prev,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

/** 单条日志详情（logId 非空时发起） */
export function useLogDetail(logId: Ref<string | null>) {
  // queryKey 用 computed 包装：logId 变化（切换记录）时重建 key，确保每次请求对应记录的最新详情
  const queryKey = computed(() => [...LOG_CENTER_KEY, 'detail', logId.value]);
  return useQuery({
    queryKey,
    queryFn: () => getLog(logId.value as string),
    enabled: computed(() => Boolean(logId.value)),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

/**
 * 批量/单行删除聚合日志（仅 admin）。成功后失效 useLogCenter 的列表缓存（含详情）。
 * 注意：本 hook 不弹 toast（toast 交给调用组件，按 skipped 情况区分提示）。
 */
export function useDeleteLogs() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: LogDeleteParams) => deleteLogs(params),
    onSuccess: () => {
      // 删除后列表与详情分区均可能变化，统一失效
      queryClient.invalidateQueries({ queryKey: [...LOG_CENTER_KEY] });
    },
    onError: () => toast.error('删除失败，请检查权限或网络'),
  });
}

export type { LogItem, LogListOut, LogListQuery, LogDeleteParams };
