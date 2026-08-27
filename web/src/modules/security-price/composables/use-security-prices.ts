/**
 * modules/security-price/composables/use-security-prices.ts — 行情数据（security-price）vue-query 层
 *
 * B11 补齐：B5 持仓批次已平移 React 版 use-security-prices.ts 中的
 * useUpsertSecurityPrice（见 modules/holdings/composables/use-security-prices.ts），
 * 此处补齐该批次仍未平移的 list / delete，并将「组合行情同步」封装为 mutation，
 * 同时对 React 版完整接口 re-export useUpsertSecurityPrice 便于统一从本模块导入。
 *
 * - useSecurityPrices：标的最新价列表（按组合 + 可选标的/日期范围查询）
 * - useDeleteSecurityPrice：删除单条价格记录（成功后失效相关缓存）
 * - useSyncPortfolioPrices：触发组合行情同步（路径 C，POST /prices/sync）
 *
 * 价格变更 / 同步会触发持仓/净值/快照重算，故成功后一并失效相关缓存。
 */

import { computed, toValue, type Ref } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { toast } from '@/composables/use-toast';
import {
  listSecurityPrices as listApi,
  deleteSecurityPrice as deleteApi,
} from '@/api/security-price.api';
import {
  syncPortfolioPrices as syncApi,
  type PriceSyncResult,
} from '@/api/portfolio-price.api';
import { priceSyncStatusKey } from '@/modules/holdings/composables/use-price-sync-status';
import type { PaginatedResponse, SecurityPriceQuery, SecurityPriceResponse } from '@/api/types';

/** 价格变更影响的所有 query key 前缀 */
const AFFECTED_QUERY_KEYS = [
  ['security-prices'],
  ['holdings'],
  ['nav'],
  ['snapshots'],
  ['overview'],
] as const;

/**
 * 标的最新价列表。
 * portfolioId 可为 ref/computed，随组合切换自动重新查询（对齐 React 版 queryKey 表达式行为）。
 */
export function useSecurityPrices(
  portfolioId: Ref<string | null> | string | null,
  query: SecurityPriceQuery = {},
) {
  const queryKey = computed(() => {
    const id = toValue(portfolioId);
    return id
      ? ['security-prices', 'list', id, query]
      : ['security-prices', 'disabled'];
  });
  return useQuery<PaginatedResponse<SecurityPriceResponse>>({
    queryKey,
    queryFn: () => listApi(toValue(portfolioId) as string, query),
    enabled: computed(() => Boolean(toValue(portfolioId))),
    staleTime: 30 * 1000,
  });
}

/** 删除价格记录（成功后失效相关缓存并提示） */
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

/**
 * 触发组合行情同步（路径 C 同步等待）。
 * 成功但存在失败条目时按失败提示；完全失败走 onError；同步会改写价格与
 * 同步状态缓存，故成功后一并失效相关 query 与 sync-status。
 */
export function useSyncPortfolioPrices() {
  const queryClient = useQueryClient();
  return useMutation<PriceSyncResult, unknown, { portfolioId: string }>({
    mutationFn: ({ portfolioId }) => syncApi(portfolioId),
    onSuccess: (result, { portfolioId }) => {
      if (result.failed > 0) {
        toast.error(`行情同步完成，但有 ${result.failed} 条失败`);
      } else {
        toast.success('行情同步完成');
      }
      AFFECTED_QUERY_KEYS.forEach((key) =>
        queryClient.invalidateQueries({ queryKey: [...key] }),
      );
      queryClient.invalidateQueries({ queryKey: priceSyncStatusKey(portfolioId) });
    },
    onError: () => {
      toast.error('行情同步失败，请稍后重试');
    },
  });
}