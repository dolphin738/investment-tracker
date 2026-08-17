/**
 * modules/holdings/composables/use-security-prices.ts — 标的最新价 upsert mutation
 *
 * 平移自 React 版 web/src/hooks/use-security-prices.ts 的 useUpsertSecurityPrice
 * （list/delete 查询归属后续 security-price 批次，此处只平移持仓页内联编辑所需部分）。
 *
 * 现价写入会触发持仓/净值/快照重算，故成功后一并失效相关缓存。
 */

import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { toast } from '@/composables/use-toast';
import { upsertSecurityPrice as upsertApi } from '@/api/security-price.api';
import type { UpsertSecurityPriceRequest } from '@/api/types';

/** 价格变更影响的所有 query key 前缀 */
const AFFECTED_QUERY_KEYS = [
  ['security-prices'],
  ['holdings'],
  ['nav'],
  ['snapshots'],
  ['overview'],
] as const;

/** 录入/覆盖标的最新价（成功后失效持仓/净值/快照/概览缓存并提示） */
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
