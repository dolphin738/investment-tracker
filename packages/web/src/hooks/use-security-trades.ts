/**
 * hooks/use-security-trades.ts — 证券买卖流水 CRUD TanStack Query hooks
 *
 * 方案B：SecurityTrade 是持仓推导唯一来源，任何写入都会影响
 * 持仓 / 净值 / XIRR / 快照 / 概览，故统一失效这些 query 缓存。
 *
 * 增量设计 K-4/C-4：买卖录入会顺带 POST /fees（transactionId 关联），
 * 因此 create 成功后再连带失效 ['fees']（兜底 fee POST 时序竞态）；
 * 其余写入（update/delete）不涉及费用拆分，保持原失效范围。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  createSecurityTrade as createApi,
  deleteSecurityTrade as deleteApi,
  listSecurityTrades as listApi,
  updateSecurityTrade as updateApi,
} from '@/api/security-trade.api';
import type {
  CreateSecurityTradeRequest,
  SecurityTradeQuery,
  SecurityTradeResponse,
  UpdateSecurityTradeRequest,
} from '@/api/types';

/** 买卖流水变更影响的所有 query key 前缀 */
const AFFECTED_QUERY_KEYS = [
  ['security-trades'],
  ['holdings'],
  ['nav'],
  ['xirr'],
  ['snapshots'],
  ['overview'],
] as const;

/** 创建成功后额外失效的费用缓存前缀（增量 K-4：买卖录入会写 FeeRecord） */
const CREATE_FEE_KEYS = [['fees']] as const;

/** 证券买卖流水列表 */
export function useSecurityTrades(
  portfolioId: string | null,
  query: SecurityTradeQuery = {},
) {
  return useQuery({
    queryKey: portfolioId
      ? ['security-trades', 'list', portfolioId, query]
      : ['security-trades', 'disabled'],
    queryFn: () => listApi(portfolioId!, query),
    enabled: Boolean(portfolioId),
    staleTime: 30 * 1000,
  });
}

/** 创建证券买卖流水（增量 C-4：前端顺序调用，先建 trade 后建 fee） */
export function useCreateSecurityTrade() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      portfolioId,
      payload,
    }: {
      portfolioId: string;
      payload: CreateSecurityTradeRequest;
    }) => createApi(portfolioId, payload),
    onSuccess: () => {
      toast.success('买卖流水已录入');
      AFFECTED_QUERY_KEYS.forEach((key) =>
        queryClient.invalidateQueries({ queryKey: [...key] }),
      );
      // 增量 K-4 兜底：买卖录入可能顺带写 FeeRecord（前端编排 POST /fees）
      CREATE_FEE_KEYS.forEach((key) =>
        queryClient.invalidateQueries({ queryKey: [...key] }),
      );
    },
  });
}

/** 更新证券买卖流水 */
export function useUpdateSecurityTrade() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      portfolioId,
      id,
      payload,
    }: {
      portfolioId: string;
      id: string;
      payload: UpdateSecurityTradeRequest;
    }) => updateApi(portfolioId, id, payload),
    onSuccess: () => {
      toast.success('买卖流水已更新');
      AFFECTED_QUERY_KEYS.forEach((key) =>
        queryClient.invalidateQueries({ queryKey: [...key] }),
      );
    },
  });
}

/** 删除证券买卖流水 */
export function useDeleteSecurityTrade() {
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
      toast.success('买卖流水已删除');
      AFFECTED_QUERY_KEYS.forEach((key) =>
        queryClient.invalidateQueries({ queryKey: [...key] }),
      );
    },
  });
}
