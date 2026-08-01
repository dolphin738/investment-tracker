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
} from '@/api/security.api';
import type { CreateSecurityDto, UpdateSecurityDto } from '@investment-tracker/shared';

/** 标的列表 */
export function useSecurities(portfolioId: string | null) {
  return useQuery({
    queryKey: ['securities', 'list', portfolioId],
    queryFn: () => listSecurities(portfolioId!),
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
