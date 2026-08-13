/**
 * hooks/use-portfolio-price.ts — 组合行情同步状态 TanStack Query hook（Q3）
 *
 * - usePriceSyncStatus：轮询某组合的行情刷新进度 / 最新 fetched_at 与来源；
 *   每 60s 自动刷新（refetchInterval），组合 id 为空时不发起请求。
 * - 与 use-quote-provider.ts 风格一致（useQuery + query key 导出）。
 */

import { useQuery } from '@tanstack/react-query';
import {
  getPriceSyncStatus,
  type PriceSyncStatus,
} from '@/api/portfolio-price.api';

/** 行情同步状态的 query key（按组合 id 失效 / 命中） */
export function priceSyncStatusKey(portfolioId: string): unknown[] {
  return ['portfolios', portfolioId, 'prices', 'sync-status'];
}

/** 读取某组合的行情同步状态（每 60s 轮询） */
export function usePriceSyncStatus(portfolioId: string | null) {
  return useQuery<PriceSyncStatus>({
    queryKey: portfolioId
      ? priceSyncStatusKey(portfolioId)
      : ['portfolios', 'none', 'prices', 'sync-status'],
    queryFn: () => getPriceSyncStatus(portfolioId as string),
    enabled: Boolean(portfolioId),
    refetchInterval: 60_000,
  });
}
