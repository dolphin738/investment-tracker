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
