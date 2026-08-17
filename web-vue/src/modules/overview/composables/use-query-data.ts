/**
 * modules/overview/composables/use-query-data.ts — XIRR / 净值查询 vue-query hooks
 *
 * 平移自 React 版 web/src/hooks/use-query-data.ts：
 * - useXirrSeries / useNavSeries：时间序列（四维度聚合）
 * - useLatestXirr / useLatestNav：最新值
 * - useNavTotalAssetMap：指定日期的系统自动总资产（按日精确查单条快照）
 * - useYearStartXirr：当年首个非空 XIRR（较年初基准，ANL-P0-04）
 */

import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import {
  getLatestNav,
  getLatestXirr,
  getNavSeries,
  getXirrSeries,
} from '@/api/query.api';
import { listSnapshots } from '@/api/snapshot.api';
import type { NavQueryParams, XirrQueryParams } from '@/api/types';
import { QueryGranularity, toNumberOrNull } from '@/lib/types';

/** XIRR 时间序列 */
export function useXirrSeries(
  portfolioId: MaybeRefOrGetter<string | null>,
  params: MaybeRefOrGetter<XirrQueryParams>,
) {
  return useQuery({
    queryKey: computed(() => ['xirr', 'series', toValue(portfolioId), toValue(params)]),
    queryFn: () => getXirrSeries(toValue(portfolioId)!, toValue(params)),
    enabled: computed(() => Boolean(toValue(portfolioId))),
    staleTime: 60 * 1000,
  });
}

/** 净值时间序列 */
export function useNavSeries(
  portfolioId: MaybeRefOrGetter<string | null>,
  params: MaybeRefOrGetter<NavQueryParams>,
) {
  return useQuery({
    queryKey: computed(() => ['nav', 'series', toValue(portfolioId), toValue(params)]),
    queryFn: () => getNavSeries(toValue(portfolioId)!, toValue(params)),
    enabled: computed(() => Boolean(toValue(portfolioId))),
    staleTime: 60 * 1000,
  });
}

/** 最新 XIRR */
export function useLatestXirr(portfolioId: MaybeRefOrGetter<string | null>) {
  return useQuery({
    queryKey: computed(() => ['xirr', 'latest', toValue(portfolioId)]),
    queryFn: () => getLatestXirr(toValue(portfolioId)!),
    enabled: computed(() => Boolean(toValue(portfolioId))),
    staleTime: 30 * 1000,
  });
}

/** 最新净值 */
export function useLatestNav(portfolioId: MaybeRefOrGetter<string | null>) {
  return useQuery({
    queryKey: computed(() => ['nav', 'latest', toValue(portfolioId)]),
    queryFn: () => getLatestNav(toValue(portfolioId)!),
    enabled: computed(() => Boolean(toValue(portfolioId))),
    staleTime: 30 * 1000,
  });
}

/**
 * 指定日期的系统自动计算总资产（AL-054 / 决策 Q-1 甲）
 *
 * 供资产记录录入表单的「覆盖提示」使用：按 date 精确查单条快照
 * （`startDate=endDate=date, pageSize=1`），取该行 `derivedTotalAsset`。
 *
 * 不再拉全量：旧实现 `pageSize:1000` 触发后端 400（SnapshotQueryDto
 * `@Max(200)`），且只取第 1 页会丢老数据（BUG-1/2）。
 * 金额为 string 透传（非计算），符合「Decimal 以 string 传输」铁律。
 */
export function useNavTotalAssetMap(
  portfolioId: MaybeRefOrGetter<string | null>,
  date: MaybeRefOrGetter<string | null>,
) {
  return useQuery({
    queryKey: computed(() => [
      'nav',
      'total-asset-map',
      toValue(portfolioId),
      toValue(date),
    ]),
    queryFn: async () => {
      const res = await listSnapshots(toValue(portfolioId)!, {
        startDate: toValue(date)!,
        endDate: toValue(date)!,
        pageSize: 1,
      });
      const row = res.items[0];
      if (!row || row.derivedTotalAsset == null) return null;
      return toNumberOrNull(row.derivedTotalAsset);
    },
    enabled: computed(() =>
      Boolean(toValue(portfolioId) && toValue(date)),
    ),
    staleTime: 60 * 1000,
  });
}

/**
 * 当年首个非空累计 XIRR（「较年初」基准，ANL-P0-04 / Part E-6）
 *
 * 口径：日粒度独立查询（从上年 1/1 起，一次请求覆盖当年 + 回退所需数据），
 * 取当年第一个 xirrValue !== null 的点作为年初基准；
 * 无当年数据 → 回退上年最后一个非空 XIRR；仍无 → null（页面渲染 '-'）。
 * 独立于页面维度/范围，不受查询范围不含年初的影响。
 */
export function useYearStartXirr(portfolioId: MaybeRefOrGetter<string | null>) {
  return useQuery({
    queryKey: computed(() => [
      'xirr',
      'year-start',
      toValue(portfolioId),
      String(new Date().getFullYear()),
    ]),
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
