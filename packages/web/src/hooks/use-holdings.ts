/**
 * hooks/use-holdings.ts — 持仓相关 TanStack Query hooks
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  listHoldings,
  upsertHolding,
  deleteHolding,
  getHoldingDates,
  syncHoldingToSnapshot,
  type HoldingQueryParams,
} from '@/api/holding.api';
import type { UpsertHoldingDto, HoldingResponse } from '@investment-tracker/shared';

/** 持仓列表（含汇总） */
export function useHoldings(
  portfolioId: string | null,
  params: HoldingQueryParams = {},
) {
  return useQuery({
    queryKey: ['holdings', 'list', portfolioId, params],
    queryFn: () => listHoldings(portfolioId!, params),
    enabled: Boolean(portfolioId),
    staleTime: 30 * 1000,
  });
}

/** 有持仓数据的日期列表 */
export function useHoldingDates(portfolioId: string | null) {
  return useQuery({
    queryKey: ['holdings', 'dates', portfolioId],
    queryFn: () => getHoldingDates(portfolioId!),
    enabled: Boolean(portfolioId),
    staleTime: 60 * 1000,
  });
}

/** 新增/更新持仓 mutation */
export function useUpsertHolding(portfolioId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpsertHoldingDto) =>
      upsertHolding(portfolioId!, payload),
    onSuccess: () => {
      toast.success('持仓已保存');
      queryClient.invalidateQueries({ queryKey: ['holdings', 'list', portfolioId] });
      queryClient.invalidateQueries({ queryKey: ['holdings', 'dates', portfolioId] });
    },
  });
}

/** 删除持仓 mutation */
export function useDeleteHolding(portfolioId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (holdingId: string) => deleteHolding(portfolioId!, holdingId),
    onSuccess: () => {
      toast.success('持仓已删除');
      queryClient.invalidateQueries({ queryKey: ['holdings', 'list', portfolioId] });
      queryClient.invalidateQueries({ queryKey: ['holdings', 'dates', portfolioId] });
    },
  });
}

/** 一键同步持仓到快照 */
export function useSyncHoldingToSnapshot(portfolioId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (date: string) => syncHoldingToSnapshot(portfolioId!, date),
    onSuccess: (_data, date) => {
      toast.success(`已同步至资产快照（${date}），并触发级联重算`);
      queryClient.invalidateQueries({ queryKey: ['nav'] });
      queryClient.invalidateQueries({ queryKey: ['xirr'] });
      queryClient.invalidateQueries({ queryKey: ['snapshots'] });
      queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
  });
}
