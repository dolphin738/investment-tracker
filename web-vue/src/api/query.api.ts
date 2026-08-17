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
import type { components } from '../types/api';
import type { NavSeriesPoint, XirrSeriesPoint } from '@/lib/types';
import { toNumberOrNull } from '@/lib/types';

type NavPointOut = components['schemas']['NavPointOut'];
type XirrPointOut = components['schemas']['XirrPointOut'];

/** 查询 XIRR 时间序列（四维度聚合） */
export function getXirrSeries(
  portfolioId: string,
  params: XirrQueryParams = {},
): Promise<XirrSeriesPoint[]> {
  // 策略 A（§5.2）：后端 XirrPointOut.value 为 string，在取数边界统一转为 number。
  return http
    .get<XirrPointOut[]>(`/portfolios/${portfolioId}/xirr`, { params })
    .then((pts) =>
      pts.map((p) => ({
        date: p.date,
        xirrValue: toNumberOrNull(p.value),
        label: p.date,
      })),
    );
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
  // 策略 A（§5.2）：后端 NavPointOut 数值字段为 string，在取数边界统一转为 number。
  return http
    .get<NavPointOut[]>(`/portfolios/${portfolioId}/nav`, { params })
    .then((pts) =>
      pts.map((p) => ({
        date: p.date,
        cumulativeNav: toNumberOrNull(p.cumulativeNav),
        yearNav: toNumberOrNull(p.yearNav),
        shares: toNumberOrNull(p.shares),
        label: p.date,
      })),
    );
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
