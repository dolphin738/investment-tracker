/**
 * hooks/use-query-data.ts — XIRR / 净值 查询 TanStack Query hooks
 *
 * - useXirrSeries：XIRR 时间序列（四维度聚合）
 * - useNavSeries：净值时间序列
 * - useLatestXirr / useLatestNav：最新值
 * - useYearStartXirr：当年首个非空 XIRR（较年初基准，ANL-P0-04）
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
 *
 * ⚠️ 近似口径（Part B-3 / F5）：NAV 计算读当日快照行（含手工值），数学上
 * cumulativeNav×shares = 当日快照值，故手工日此值 ≈ 手工值（失真）、无快照日缺失。
 * PRD 要求「该日系统自动计算值」= computeDerived(date)（实时算 marketValue+cashBalance，
 * 不受手工覆盖影响），后端 list 补齐 derivedTotalAsset 前一律以本近似为准。
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

/**
 * 当年首个非空累计 XIRR（「较年初」基准，ANL-P0-04 / Part E-6）
 *
 * 口径：日粒度独立查询（从上年 1/1 起，一次请求覆盖当年 + 回退所需数据），
 * 取当年第一个 xirrValue !== null 的点作为年初基准；
 * 无当年数据 → 回退上年最后一个非空 XIRR；仍无 → null（页面渲染 '-'）。
 * 独立于页面维度/范围，不受查询范围不含年初的影响（修复旧实现缺陷，见 Part A2）。
 */
export function useYearStartXirr(portfolioId: string | null) {
  return useQuery({
    queryKey: ['xirr', 'year-start', portfolioId, String(new Date().getFullYear())],
    queryFn: async () => {
      const year = new Date().getFullYear();
      const points = await getXirrSeries(portfolioId!, {
        granularity: QueryGranularity.DAY,
        startDate: `${year - 1}-01-01`,
      });
      const yearPrefix = String(year);
      const yearPoint = points.find(
        (p) => p.xirrValue !== null && p.date.startsWith(yearPrefix),
      );
      if (yearPoint) return yearPoint.xirrValue;
      // 回退上年最后一个非空
      const prevPrefix = String(year - 1);
      let prev: number | null = null;
      for (const p of points) {
        if (p.date.startsWith(prevPrefix) && p.xirrValue !== null) {
          prev = p.xirrValue;
        }
      }
      return prev;
    },
    enabled: Boolean(portfolioId),
    staleTime: 60 * 1000,
  });
}
