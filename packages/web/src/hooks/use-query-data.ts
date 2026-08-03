/**
 * hooks/use-query-data.ts — XIRR / 净值 查询 TanStack Query hooks
 *
 * - useXirrSeries：XIRR 时间序列（四维度聚合）
 * - useNavSeries：净值时间序列
 * - useLatestXirr / useLatestNav：最新值
 */

import { useQuery } from '@tanstack/react-query';
import {
  getLatestNav,
  getLatestXirr,
  getNavSeries,
  getXirrSeries,
} from '@/api/query.api';
import type { NavQueryParams, XirrQueryParams } from '@/api/types';
import { QueryGranularity } from '@investment-tracker/shared';

/** XIRR 时间序列 */
export function useXirrSeries(
  portfolioId: string | null,
  params: XirrQueryParams,
) {
  return useQuery({
    queryKey: ['xirr', 'series', portfolioId, params],
    queryFn: () => getXirrSeries(portfolioId!, params),
    enabled: Boolean(portfolioId),
    staleTime: 60 * 1000,
  });
}

/** 净值时间序列 */
export function useNavSeries(
  portfolioId: string | null,
  params: NavQueryParams,
) {
  return useQuery({
    queryKey: ['nav', 'series', portfolioId, params],
    queryFn: () => getNavSeries(portfolioId!, params),
    enabled: Boolean(portfolioId),
    staleTime: 60 * 1000,
  });
}

/** 最新 XIRR */
export function useLatestXirr(portfolioId: string | null) {
  return useQuery({
    queryKey: ['xirr', 'latest', portfolioId],
    queryFn: () => getLatestXirr(portfolioId!),
    enabled: Boolean(portfolioId),
    staleTime: 30 * 1000,
  });
}

/** 最新净值 */
export function useLatestNav(portfolioId: string | null) {
  return useQuery({
    queryKey: ['nav', 'latest', portfolioId],
    queryFn: () => getLatestNav(portfolioId!),
    enabled: Boolean(portfolioId),
    staleTime: 30 * 1000,
  });
}

/**
 * 系统自动计算的总资产映射（date → cumulativeNav × shares）
 *
 * 供资产记录页展示「该日系统自动计算值」与「差异%」：
 * 系统口径下 总资产 = 累计净值 × 份额，与后端 recalculateNavRange 口径一致。
 * 采用日维度全量查询（startDate=2000-01-01 覆盖成立日至今）。
 */
export function useNavTotalAssetMap(portfolioId: string | null) {
  return useQuery({
    queryKey: ['nav', 'total-asset-map', portfolioId],
    queryFn: async () => {
      const points = await getNavSeries(portfolioId!, {
        granularity: QueryGranularity.DAY,
        startDate: '2000-01-01',
      });
      const map = new Map<string, number>();
      for (const p of points) {
        if (
          p.cumulativeNav !== null &&
          p.shares !== null &&
          Number.isFinite(p.cumulativeNav) &&
          Number.isFinite(p.shares)
        ) {
          map.set(p.date, p.cumulativeNav * p.shares);
        }
      }
      return map;
    },
    enabled: Boolean(portfolioId),
    staleTime: 60 * 1000,
  });
}
