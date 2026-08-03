/**
 * hooks/use-security-prices.ts — 标的最新价 TanStack Query hooks
 *
 * 现价内联编辑（持仓页）使用 useUpsertSecurityPrice；
 * 写入会触发持仓/净值/快照重算，故一并失效相关缓存。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  deleteSecurityPrice as deleteApi,
  listSecurityPrices as listApi,
  upsertSecurityPrice as upsertApi,
} from '@/api/security-price.api';
import type {
  SecurityPriceQuery,
  UpsertSecurityPriceRequest,
} from '@/api/types';

/** 价格变更影响的所有 query key 前缀 */
const AFFECTED_QUERY_KEYS = [
  ['security-prices'],
  ['holdings'],
  ['nav'],
  ['snapshots'],
  ['overview'],
] as const;

/** 标的最新价列表 */
export function useSecurityPrices(
  portfolioId: string | null,
  query: SecurityPriceQuery = {},
) {
  return useQuery({
    queryKey: portfolioId
      ? ['security-prices', 'list', portfolioId, query]
      : ['security-prices', 'disabled'],
    queryFn: () => listApi(portfolioId!, query),
    enabled: Boolean(portfolioId),
    staleTime: 30 * 1000,
  });
}

/** 录入/覆盖标的最新价 */
export function useUpsertSecurityPrice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      portfolioId,
      payload,
    }: {
      portfolioId: string;
      payload: UpsertSecurityPriceRequest;
    }) => upsertApi(portfolioId, payload),
    onSuccess: () => {
      toast.success('现价已更新');
      AFFECTED_QUERY_KEYS.forEach((key) =>
        queryClient.invalidateQueries({ queryKey: [...key] }),
      );
    },
  });
}

/** 删除价格记录 */
export function useDeleteSecurityPrice() {
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
      toast.success('价格记录已删除');
      AFFECTED_QUERY_KEYS.forEach((key) =>
        queryClient.invalidateQueries({ queryKey: [...key] }),
      );
    },
  });
}
