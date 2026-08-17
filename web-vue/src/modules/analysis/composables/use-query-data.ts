/**
 * modules/analysis/composables/use-query-data.ts — XIRR / 净值查询 vue-query hooks
 *
 * 平移自 React 版 web/src/hooks/use-query-data.ts 的分析页相关 hooks
 * （queryKey / staleTime / enabled 语义一致），供 XIRR 分析页与净值分析页复用。
 *
 * 参数支持 ref / computed 传入（组合切换、维度筛选变化时 queryKey 自动跟随）。
 * React 版 useNavTotalAssetMap 属资产快照域，平移至
 * modules/snapshot/composables/use-snapshots.ts，不在本文件。
 */

import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import {
  getLatestNav,
  getLatestXirr,
  getNavSeries,
  getXirrSeries,
} from '@/api/query.api';
import type { NavQueryParams, XirrQueryParams } from '@/api/types';
import { QueryGranularity } from '@/lib/types';

/** XIRR 时间序列（四维度聚合） */
export function useXirrSeries(
  portfolioId: MaybeRefOrGetter<string | null>,
  params: MaybeRefOrGetter<XirrQueryParams>,
) {
  return useQuery({
    queryKey: computed(() => {
      const id = toValue(portfolioId);
      return id
        ? ['xirr', 'series', id, toValue(params)]
        : ['xirr', 'series', 'disabled'];
    }),
    queryFn: () => getXirrSeries(toValue(portfolioId)!, toValue(params)),
    enabled: computed(() => Boolean(toValue(portfolioId))),
    staleTime: 60 * 1000,
  });
}

/** 净值时间序列（四维度聚合） */
export function useNavSeries(
  portfolioId: MaybeRefOrGetter<string | null>,
  params: MaybeRefOrGetter<NavQueryParams>,
) {
  return useQuery({
    queryKey: computed(() => {
      const id = toValue(portfolioId);
      return id
        ? ['nav', 'series', id, toValue(params)]
        : ['nav', 'series', 'disabled'];
    }),
    queryFn: () => getNavSeries(toValue(portfolioId)!, toValue(params)),
    enabled: computed(() => Boolean(toValue(portfolioId))),
    staleTime: 60 * 1000,
  });
}

/** 最新 XIRR */
export function useLatestXirr(portfolioId: MaybeRefOrGetter<string | null>) {
  return useQuery({
    queryKey: computed(() => {
      const id = toValue(portfolioId);
      return id ? ['xirr', 'latest', id] : ['xirr', 'latest', 'disabled'];
    }),
    queryFn: () => getLatestXirr(toValue(portfolioId)!),
    enabled: computed(() => Boolean(toValue(portfolioId))),
    staleTime: 30 * 1000,
  });
}

/** 最新净值 */
export function useLatestNav(portfolioId: MaybeRefOrGetter<string | null>) {
  return useQuery({
    queryKey: computed(() => {
      const id = toValue(portfolioId);
      return id ? ['nav', 'latest', id] : ['nav', 'latest', 'disabled'];
    }),
    queryFn: () => getLatestNav(toValue(portfolioId)!),
    enabled: computed(() => Boolean(toValue(portfolioId))),
    staleTime: 30 * 1000,
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
export function useYearStartXirr(portfolioId: MaybeRefOrGetter<string | null>) {
  return useQuery({
    queryKey: computed(() => {
      const id = toValue(portfolioId);
      return id
        ? ['xirr', 'year-start', id, String(new Date().getFullYear())]
        : ['xirr', 'year-start', 'disabled'];
    }),
    queryFn: async () => {
      const year = new Date().getFullYear();
      const points = await getXirrSeries(toValue(portfolioId)!, {
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
    enabled: computed(() => Boolean(toValue(portfolioId))),
    staleTime: 60 * 1000,
  });
}
