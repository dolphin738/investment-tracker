/**
 * modules/holdings/composables/use-price-sync-status.ts — 组合行情同步状态查询
 *
 * 平移自 React 版 web/src/hooks/use-portfolio-price.ts 的 usePriceSyncStatus。
 * 每 60s 自动刷新（refetchInterval），组合 id 为空时不发起请求。
 *
 * queryKey 用 computed 包裹：portfolioId 为 ref/computed 时随组合切换自动
 * 重新查询（对齐 React 版 queryKey 表达式行为）。
 */

import { computed, toValue, type Ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import {
  getPriceSyncStatus,
  type PriceSyncStatus,
} from '@/api/portfolio-price.api';

/** 行情同步状态的 query key（按组合 id 失效 / 命中） */
export function priceSyncStatusKey(portfolioId: string): unknown[] {
  return ['portfolios', portfolioId, 'prices', 'sync-status'];
}

/** 读取某组合的行情同步状态（每 60s 轮询） */
export function usePriceSyncStatus(portfolioId: Ref<string | null> | string | null) {
  const queryKey = computed(() => {
    const id = toValue(portfolioId);
    return id
      ? priceSyncStatusKey(id)
      : ['portfolios', 'none', 'prices', 'sync-status'];
  });
  return useQuery<PriceSyncStatus>({
    queryKey,
    queryFn: () => getPriceSyncStatus(toValue(portfolioId) as string),
    enabled: computed(() => Boolean(toValue(portfolioId))),
    refetchInterval: 60_000,
  });
}
