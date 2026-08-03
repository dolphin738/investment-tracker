/**
 * 四维度查询参数定义
 *
 * XIRR / 净值查询支持按 日/周/月/年 聚合，
 * 每种粒度可指定聚合方式：取期末值(last) 或 均值(avg)。
 */

import type { DateRangeQuery } from './api.ts';

/**
 * 查询粒度枚举
 * - DAY：按日查询（不聚合，返回每日原始数据）
 * - WEEK：按周聚合（ISO 周）
 * - MONTH：按月聚合
 * - YEAR：按年聚合
 *
 * 使用 as const 对象 + 派生类型（而非 TS enum），保证源码可被
 * Node ESM type-stripping 直接加载，且与 Prisma 字符串字面量兼容。
 */
export const QueryGranularity = {
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
  YEAR: 'year',
} as const;

/** 查询粒度（'day' | 'week' | 'month' | 'year'） */
export type QueryGranularity =
  typeof QueryGranularity[keyof typeof QueryGranularity];

/**
 * 聚合方式枚举
 * - LAST：取该时间段内最后一条记录的值（期末值）
 * - AVG：取该时间段内所有记录的算术平均值
 */
export const AggregationMethod = {
  LAST: 'last',
  AVG: 'avg',
} as const;

/** 聚合方式（'last' | 'avg'） */
export type AggregationMethod =
  typeof AggregationMethod[keyof typeof AggregationMethod];

/**
 * 净值查询的指标选择
 */
export const NavMetric = {
  /** 仅累计净值 */
  CUMULATIVE: 'cumulative',
  /** 仅当年净值 */
  YEAR: 'year',
  /** 两者都返回 */
  BOTH: 'both',
} as const;

/** 净值查询指标（'cumulative' | 'year' | 'both'） */
export type NavMetric = typeof NavMetric[keyof typeof NavMetric];

/**
 * 四维度查询参数（XIRR）
 *
 * 对应 API: GET /portfolios/:portfolioId/xirr
 */
export interface XirrQuery extends DateRangeQuery {
  /** 查询粒度，默认 day */
  granularity?: QueryGranularity;
  /** 聚合方式，默认 last（期末值） */
  aggregation?: AggregationMethod;
}

/**
 * 四维度查询参数（净值）
 *
 * 对应 API: GET /portfolios/:portfolioId/nav
 */
export interface NavQuery extends DateRangeQuery {
  /** 查询粒度，默认 day */
  granularity?: QueryGranularity;
  /** 聚合方式，默认 last（期末值） */
  aggregation?: AggregationMethod;
  /** 返回指标选择，默认 both（累计净值 + 当年净值都返回） */
  metric?: NavMetric;
}
