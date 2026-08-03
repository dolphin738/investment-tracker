/**
 * hooks/use-portfolios.ts — 组合 CRUD TanStack Query hooks
 *
 * - usePortfolios：列表 query
 * - useCreatePortfolio / useUpdatePortfolio / useArchivePortfolio / useDeletePortfolio：mutation
 * - 自动同步 portfolio store
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  archivePortfolio as archiveApi,
  clearPortfolioData as clearDataApi,
  createPortfolio as createApi,
  deletePortfolio as deleteApi,
  listPortfolios as listApi,
  updatePortfolio as updateApi,
} from '@/api/portfolio.api';
import { usePortfolioStore } from '@/stores/portfolio.store';
import type {
  CreatePortfolioRequest,
  UpdatePortfolioRequest,
} from '@/api/types';

/** 组合列表 query key */
export const PORTFOLIOS_KEY = ['portfolios'] as const;

/** 组合列表 */
export function usePortfolios() {
  const setPortfolios = usePortfolioStore((s) => s.setPortfolios);
  const query = useQuery({
    queryKey: PORTFOLIOS_KEY,
    queryFn: async () => {
      const list = await listApi();
      setPortfolios(list);
      return list;
    },
    staleTime: 60 * 1000,
  });
  return query;
}

/** 创建组合 */
export function useCreatePortfolio() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreatePortfolioRequest) => createApi(payload),
    onSuccess: () => {
      toast.success('组合已创建');
      queryClient.invalidateQueries({ queryKey: PORTFOLIOS_KEY });
    },
  });
}

/** 更新组合 */
export function useUpdatePortfolio() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      payload: UpdatePortfolioRequest;
    }) => updateApi(id, payload),
    onSuccess: () => {
      toast.success('组合已更新');
      queryClient.invalidateQueries({ queryKey: PORTFOLIOS_KEY });
    },
  });
}

/** 归档/取消归档组合 */
export function useArchivePortfolio() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      archiveApi(id, archived),
    onSuccess: (_data, { archived }) => {
      toast.success(archived ? '组合已归档' : '组合已取消归档');
      queryClient.invalidateQueries({ queryKey: PORTFOLIOS_KEY });
    },
  });
}

/** 删除组合（级联删除子数据） */
export function useDeletePortfolio() {
  const queryClient = useQueryClient();
  const clearCurrent = usePortfolioStore((s) => s.clearCurrent);
  return useMutation({
    mutationFn: (id: string) => deleteApi(id),
    onSuccess: (_data, deletedId) => {
      toast.success('组合已删除');
      const { currentPortfolioId } = usePortfolioStore.getState();
      if (currentPortfolioId === deletedId) {
        clearCurrent();
      }
      queryClient.invalidateQueries({ queryKey: PORTFOLIOS_KEY });
    },
  });
}

/** 清空组合全部数据（保留组合本身，SET-P0-05 危险操作区） */
export function useClearPortfolioData() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => clearDataApi(id),
    onSuccess: () => {
      toast.success('组合数据已清空');
      // 清空后概览/分析/持仓等数据全部失效，统一失效重取
      queryClient.invalidateQueries();
    },
  });
}
