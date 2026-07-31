/**
 * 四维度查询参数定义
 *
 * XIRR / 净值查询支持按 日/周/月/年 聚合，
 * 每种粒度可指定聚合方式：取期末值(last) 或 均值(avg)。
 */

import type { DateRangeQuery } from './api.js';

/**
 * 查询粒度枚举
 * - DAY：按日查询（不聚合，返回每日原始数据）
 * - WEEK：按周聚合（ISO 周）
 * - MONTH：按月聚合
 * - YEAR：按年聚合
 */
export enum QueryGranularity {
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
  YEAR = 'year',
}

/**
 * 聚合方式枚举
 * - LAST：取该时间段内最后一条记录的值（期末值）
 * - AVG：取该时间段内所有记录的算术平均值
 */
export enum AggregationMethod {
  LAST = 'last',
  AVG = 'avg',
}

/**
 * 净值查询的指标选择
 */
export enum NavMetric {
  /** 仅累计净值 */
  CUMULATIVE = 'cumulative',
  /** 仅当年净值 */
  YEAR = 'year',
  /** 两者都返回 */
  BOTH = 'both',
}

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
