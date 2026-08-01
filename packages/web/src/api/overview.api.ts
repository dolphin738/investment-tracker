/**
 * api/overview.api.ts — 概览聚合 API
 *
 * 对应后端：
 * - GET /api/portfolios/:id/overview   — 单组合概览
 * - GET /api/portfolios/summary        — 全部组合摘要
 */

import { http } from '@/lib/api-client';
import type { OverviewResponse, PortfolioSummary } from './types';

/** 获取单个组合概览数据 */
export function getOverview(portfolioId: string): Promise<OverviewResponse> {
  return http.get<OverviewResponse>(`/portfolios/${portfolioId}/overview`);
}

/** 获取全部组合摘要列表 */
export function getPortfoliosSummary(): Promise<PortfolioSummary[]> {
  return http.get<PortfolioSummary[]>('/portfolios/summary');
}
