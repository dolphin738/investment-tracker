/**
 * hooks/use-security-master.ts — 系统级证券主数据 TanStack Query hooks
 *
 * 与既有 use-securities / use-quote-interface 风格一致：
 * - useSecurityMasters：useQuery（enabled: isAdmin），分页参数由调用方控制；
 * - useSyncSecurityMasters：useMutation，成功后失效主数据列表缓存。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  listSecurityMasters,
  syncSecurityMasters,
} from '@/api/security-master.api';
import { useIsAdmin } from '@/stores/auth.store';

/** 系统级证券主数据列表（分页）；非管理员不发起请求 */
export function useSecurityMasters(params: {
  page: number;
  pageSize: number;
  q?: string;
}) {
  const isAdmin = useIsAdmin();
  return useQuery({
    queryKey: ['security-masters', 'list', params.page, params.pageSize, params.q ?? ''],
    queryFn: () => listSecurityMasters(params),
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
    },
    onError: () => toast.error('同步失败，请检查接口配置'),
  });
}
