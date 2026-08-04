/**
 * hooks/use-cash-balances.ts — 现金余额 TanStack Query hooks
 *
 * - useCashBalances：列表 query
 * - useLatestCashBalance：最新生效余额 query（asOf 最近一条）
 * - useUpsertCashBalance / useDeleteCashBalance：mutation
 *
 * 现金余额参与净值/XIRR 重算，写入后一并失效相关缓存。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  deleteCashBalance as deleteApi,
  getLatestCashBalance as getLatestApi,
  listCashBalances as listApi,
  upsertCashBalance as upsertApi,
} from '@/api/cash-balance.api';
import type {
  CashBalanceQuery,
  UpsertCashBalanceRequest,
} from '@/api/types';

/** 余额变更影响的所有 query key 前缀 */
const AFFECTED_QUERY_KEYS = [
  ['cash-balances'],
  ['nav'],
  ['xirr'],
  ['snapshots'],
  ['overview'],
] as const;

/** 现金余额列表 */
export function useCashBalances(
  portfolioId: string | null,
  query: CashBalanceQuery = {},
) {
  return useQuery({
    queryKey: portfolioId
      ? ['cash-balances', 'list', portfolioId, query]
      : ['cash-balances', 'disabled'],
    queryFn: () => listApi(portfolioId!, query),
    enabled: Boolean(portfolioId),
    staleTime: 30 * 1000,
  });
}

/** 最新生效现金余额（asOf 最近一条） */
export function useLatestCashBalance(portfolioId: string | null) {
  return useQuery({
    queryKey: ['cash-balances', 'latest', portfolioId],
    queryFn: () => getLatestApi(portfolioId!),
    enabled: Boolean(portfolioId),
    staleTime: 30 * 1000,
  });
}

/** 录入/覆盖现金余额 */
export function useUpsertCashBalance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      portfolioId,
      payload,
    }: {
      portfolioId: string;
      payload: UpsertCashBalanceRequest;
    }) => upsertApi(portfolioId, payload),
    onSuccess: () => {
      // CASH-P0-03 重算范围反馈：依赖后端 recalc 并入响应（与 F3 通用修复联动），
      // 当前保持「现金余额已保存」；后端透出 recalculation 后可在此拼接「已重算自 {asOf} 起」。
      toast.success('现金余额已保存');
      AFFECTED_QUERY_KEYS.forEach((key) =>
        queryClient.invalidateQueries({ queryKey: [...key] }),
      );
    },
  });
}

/** 删除现金余额记录 */
export function useDeleteCashBalance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      portfolioId,
      id,
    }: {
      portfolioId: string;
      id: string;
    }) => deleteApi(portfolioId, id),
    onSuccess: () => {
      toast.success('现金余额记录已删除');
      AFFECTED_QUERY_KEYS.forEach((key) =>
        queryClient.invalidateQueries({ queryKey: [...key] }),
      );
    },
  });
}
