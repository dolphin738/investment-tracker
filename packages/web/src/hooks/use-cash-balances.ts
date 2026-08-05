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

/** 余额变更影响的所有 query key 前缀（T04 验收 4：含 holdings） */
const AFFECTED_QUERY_KEYS = [
  ['cash-balances'],
  ['overview'],
  ['nav'],
  ['xirr'],
  ['snapshots'],
  ['holdings'],
] as const;

/**
 * 重算反馈文案（CASH-P0-03 / T04 验收 3）：
 * 后端暂未在响应中返回重算天数 → 降级「已重算（自 {asOf} 起）」，不报错。
 * 后端补齐 recalculation 后可在调用处拼接「已重算 {fromDate} 起 {N} 天」。
 */
function buildRecalcSuffix(asOf: string): string {
  return `已重算（自 ${asOf} 起）`;
}

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
    onSuccess: (_data, variables) => {
      // CASH-P0-03 重算反馈：后端未返回天数 → 降级「已重算（自 asOf 起）」（T04 验收 3）
      toast.success(`现金余额已保存；${buildRecalcSuffix(variables.payload.asOf)}`);
      AFFECTED_QUERY_KEYS.forEach((key) =>
        queryClient.invalidateQueries({ queryKey: [...key] }),
      );
    },
  });
}

/** 删除现金余额记录（asOf 可选：用于重算反馈 toast 文案） */
export function useDeleteCashBalance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      portfolioId,
      id,
    }: {
      portfolioId: string;
      id: string;
      /** 被删除记录的生效日（仅用于重算反馈 toast） */
      asOf?: string;
    }) => deleteApi(portfolioId, id),
    onSuccess: (_data, variables) => {
      toast.success(
        variables.asOf
          ? `现金余额记录已删除；${buildRecalcSuffix(variables.asOf)}`
          : '现金余额记录已删除',
      );
      AFFECTED_QUERY_KEYS.forEach((key) =>
        queryClient.invalidateQueries({ queryKey: [...key] }),
      );
    },
  });
}
