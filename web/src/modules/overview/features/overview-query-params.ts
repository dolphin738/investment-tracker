/**
 * modules/overview/features/overview-query-params.ts — 概览页 URL 查询状态（T03 · AL-014）
 *
 * 平移自 React 版 web/src/features/overview/overview-query-params.ts。
 *
 * URL key（对齐增量设计 §3.3，均小写）：
 * - g       day|week|month|year（缺省 = 偏好 defaultGranularity，通常 month）
 * - range   1w|1m|3m|6m|1y|ytd|all|custom（缺省 = 偏好 defaultDateRange，通常 1y）
 * - from    YYYY-MM-DD（仅 range=custom 时生效）
 * - to      YYYY-MM-DD（仅 range=custom 时生效）
 *
 * 约定：默认值不写入 URL；非法值静默降级；白名单外 key 忽略。
 */

import { dateCodec, enumCodec } from '@/lib/url-query';
import type { UrlStateSchema } from '@/lib/url-query';

/** 维度白名单（与 GRANULARITY_TABS / shared QueryGranularity 对齐） */
export const OVERVIEW_GRANULARITY_VALUES = [
  'day',
  'week',
  'month',
  'year',
] as const;

/** 范围白名单（QUICK_RANGE_OPTIONS 7 项 + custom） */
export const OVERVIEW_RANGE_VALUES = [
  '1w',
  '1m',
  '3m',
  '6m',
  '1y',
  'ytd',
  'all',
  'custom',
] as const;

/** 概览页 URL 查询状态 */
export interface OverviewQueryState {
  /** 时间维度 day|week|month|year */
  g: (typeof OVERVIEW_GRANULARITY_VALUES)[number];
  /** 快捷范围 1w|1m|3m|6m|1y|ytd|all|custom */
  range: (typeof OVERVIEW_RANGE_VALUES)[number];
  /** 自定义起始日 YYYY-MM-DD（range=custom） */
  from: string;
  /** 自定义截止日 YYYY-MM-DD（range=custom） */
  to: string;
}

/**
 * 构造 useUrlState schema。
 *
 * @param defaultGranularity 缺省维度（UserPreference.defaultGranularity）
 * @param defaultRange 缺省范围（UserPreference.defaultDateRange）
 */
export function createOverviewSchema(
  defaultGranularity: string,
  defaultRange: string,
): UrlStateSchema<OverviewQueryState> {
  return {
    g: enumCodec(
      OVERVIEW_GRANULARITY_VALUES,
      defaultGranularity as OverviewQueryState['g'],
    ),
    range: enumCodec(
      OVERVIEW_RANGE_VALUES,
      defaultRange as OverviewQueryState['range'],
    ),
    from: dateCodec(''),
    to: dateCodec(''),
  };
}
