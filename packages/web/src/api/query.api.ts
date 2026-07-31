/**
 * api/query.api.ts — 四维度查询 API（XIRR / 净值 时间序列 + 最新值）
 *
 * 对应后端 /api/portfolios/:portfolioId：
 * - GET /xirr          — XIRR 时间序列（日/周/月/年聚合）
 * - GET /xirr/latest   — 最新 XIRR
 * - GET /nav            — 净值时间序列
 * - GET /nav/latest     — 最新净值
 */

import { http } from '@/lib/api-client';
import type { NavQueryParams, XirrQueryParams } from './types';
import type { NavSeriesPoint, XirrSeriesPoint } from '@investment-tracker/shared';

/** 查询 XIRR 时间序列（四维度聚合） */
export function getXirrSeries(
  portfolioId: string,
  params: XirrQueryParams = {},
): Promise<XirrSeriesPoint[]> {
  return http.get<XirrSeriesPoint[]>(`/portfolios/${portfolioId}/xirr`, {
    params,
  });
}

/** 获取最新 XIRR */
export function getLatestXirr(
  portfolioId: string,
): Promise<{ date: string; xirrValue: number | null }> {
  return http.get(`/portfolios/${portfolioId}/xirr/latest`);
}

/** 查询净值时间序列（四维度聚合） */
export function getNavSeries(
  portfolioId: string,
  params: NavQueryParams = {},
): Promise<NavSeriesPoint[]> {
  return http.get<NavSeriesPoint[]>(`/portfolios/${portfolioId}/nav`, {
    params,
  });
}

/** 获取最新净值 */
export function getLatestNav(
  portfolioId: string,
): Promise<{
  date: string;
  cumulativeNav: number | null;
  yearNav: number | null;
  shares: number | null;
}> {
  return http.get(`/portfolios/${portfolioId}/nav/latest`);
}
