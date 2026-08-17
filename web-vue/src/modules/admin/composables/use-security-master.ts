/**
 * modules/admin/composables/use-security-master.ts — 系统级证券主数据 vue-query hooks
 *
 * 平移自 React 版 web/src/hooks/use-security-master.ts，行为契约一致。
 * - useSecurityMasters：useQuery（enabled: isAdmin），分页参数由调用方以响应式传入；
 * - useSecurityMasterStats：主数据按资产类别统计；
 * - useSyncSecurityMasters：手动触发全量同步，成功后失效列表与统计缓存；
 * - useDeleteSecurityMasters：批量/单行删除（不弹 toast，toast 交给调用组件区分提示）。
 */

import { computed, toValue, type ComputedRef } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { toast } from '@/composables/use-toast';
import {
  deleteSecurityMasters,
  getSecurityMasterStats,
  listSecurityMasters,
  syncSecurityMasters,
  type SecurityMasterQuery,
  type SecurityMasterDeleteParams,
} from '@/api/security-master.api';
import { useIsAdmin } from '@/stores/auth.store';

/** 系统级证券主数据列表（分页 + 关键字 + 类别筛选）；非管理员不发起请求 */
export function useSecurityMasters(params: ComputedRef<SecurityMasterQuery>) {
  const isAdmin = useIsAdmin();
  return useQuery({
    queryKey: computed(() => [
      'security-masters',
      'list',
      params.value.page,
      params.value.pageSize,
      params.value.q ?? '',
      params.value.assetClass ?? '',
      params.value.exchange ?? '',
    ]),
    queryFn: () => listSecurityMasters(toValue(params)),
    enabled: isAdmin,
    staleTime: 30 * 1000,
  });
}

/** 主数据按资产类别统计条数；非管理员不发起请求 */
export function useSecurityMasterStats() {
  const isAdmin = useIsAdmin();
  return useQuery({
    queryKey: ['security-masters', 'stats'],
    queryFn: () => getSecurityMasterStats(),
    enabled: isAdmin,
    staleTime: 30 * 1000,
  });
}

/** 手动触发主数据全量同步 */
export function useSyncSecurityMasters() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => syncSecurityMasters(),
    onSuccess: (data) => {
      toast.success(`同步完成：成功 ${data.synced} 条，失败 ${data.failed} 条`);
      queryClient.invalidateQueries({ queryKey: ['security-masters', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['security-masters', 'stats'] });
    },
    onError: () => toast.error('同步失败，请检查接口配置'),
  });
}

/**
 * 批量/单行删除证券主数据（仅管理员）；成功后失效列表与统计缓存。
 * 注意：本 hook 不弹 toast（toast 交给调用组件，按 skipped 情况区分提示）。
 */
export function useDeleteSecurityMasters() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: SecurityMasterDeleteParams) => deleteSecurityMasters(params),
    onSuccess: (data) => {
      // 列表与统计均可能变化，统一失效（调用方再据 data 提示）
      queryClient.invalidateQueries({ queryKey: ['security-masters', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['security-masters', 'stats'] });
    },
    onError: () => toast.error('删除失败，请检查权限或网络'),
  });
}