/**
 * hooks/use-securities.ts — 标的管理 TanStack Query hooks
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  listSecurities,
  createSecurity,
  updateSecurity,
  deleteSecurity,
  resolveSecurity,
  type ResolveSecurityRequest,
} from '@/api/security.api';
import type { CreateSecurityDto, PaginatedResponse, Security, UpdateSecurityDto } from '@/api/types';

/** 标的列表（后端返回分页结构，select 解包为纯数组，调用方直接用 data 即可） */
export function useSecurities(portfolioId: string | null) {
  return useQuery<PaginatedResponse<Security>, Error, Security[]>({
    queryKey: ['securities', 'list', portfolioId],
    queryFn: () => listSecurities(portfolioId!),
    select: (res) => res?.items ?? [],
    enabled: Boolean(portfolioId),
    staleTime: 60 * 1000,
  });
}

/** 新增标的 */
export function useCreateSecurity(portfolioId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateSecurityDto) =>
      createSecurity(portfolioId!, payload),
    onSuccess: () => {
      toast.success('标的新增成功');
      queryClient.invalidateQueries({ queryKey: ['securities', 'list', portfolioId] });
    },
  });
}

/** 编辑标的 */
export function useUpdateSecurity(portfolioId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      securityId,
      payload,
    }: {
      securityId: string;
      payload: UpdateSecurityDto;
    }) => updateSecurity(portfolioId!, securityId, payload),
    onSuccess: () => {
      toast.success('标的已更新');
      queryClient.invalidateQueries({ queryKey: ['securities', 'list', portfolioId] });
    },
  });
}

/** 删除标的 */
export function useDeleteSecurity(portfolioId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (securityId: string) =>
      deleteSecurity(portfolioId!, securityId),
    onSuccess: () => {
      toast.success('标的已删除（含关联持仓）');
      queryClient.invalidateQueries({ queryKey: ['securities', 'list', portfolioId] });
      queryClient.invalidateQueries({ queryKey: ['holdings', 'list', portfolioId] });
    },
  });
}

/**
 * 选中系统主数据 → 懒实例化为组合标的（§7 ③ / §10）。
 *
 * 录入买卖表单用：从搜索候选选中主数据行后调用，拿到组合维度 securityId 回填表单；
 * 成功后失效标的列表缓存（新实例化的组合行立即可见于分红/快照等下拉）。
 */
export function useResolveSecurity(portfolioId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ResolveSecurityRequest) =>
      resolveSecurity(portfolioId!, payload),
    onSuccess: (data) => {
      toast.success(data.isNew ? `已创建组合标的「${data.name}」` : '标的已选中');
      queryClient.invalidateQueries({ queryKey: ['securities', 'list', portfolioId] });
    },
    onError: () => toast.error('标的解析失败，请重试'),
  });
}
