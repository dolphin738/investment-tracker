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
import { listSnapshots } from '@/api/snapshot.api';
import type { NavQueryParams, XirrQueryParams } from '@/api/types';
import { QueryGranularity, toNumberOrNull } from '@/lib/types';

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
 * 指定日期的系统自动计算总资产（AL-054 / 决策 Q-1 甲）
 *
 * 供资产记录录入表单的「覆盖提示」使用：按 date 精确查单条快照
 * （`startDate=endDate=date, pageSize=1` —— 合法且 ≤ 后端 `@Max(200)`），
 * 取该行 `derivedTotalAsset`（后端实时回填：DERIVED 行 == totalAsset；
 * MANUAL 行为 computeDerived 结果；计算失败 → null）。
 *
 * 🔴 不再拉全量：旧实现 `pageSize:1000` 触发后端 400（SnapshotQueryDto
 * `@Max(200)` + 全局 ValidationPipe），且只取第 1 页会丢老数据（BUG-1/2）。
 * 快照列表页自身的派生值直接读列表行内 `derivedTotalAsset`，不经过本 hook。
 *
 * 金额为 string 透传（非计算），符合「Decimal 以 string 传输」铁律。
 */
export function useNavTotalAssetMap(
  portfolioId: string | null,
  date: string | null,
) {
  return useQuery({
    queryKey: ['nav', 'total-asset-map', portfolioId, date],
    queryFn: async () => {
      const res = await listSnapshots(portfolioId!, {
        startDate: date!,
        endDate: date!,
        pageSize: 1,
      });
      const row = res.items[0];
      if (!row || row.derivedTotalAsset == null) return null;
      return toNumberOrNull(row.derivedTotalAsset);
    },
    enabled: Boolean(portfolioId && date),
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
