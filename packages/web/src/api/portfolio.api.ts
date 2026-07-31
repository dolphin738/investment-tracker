/**
 * api/portfolio.api.ts — 组合管理 API
 *
 * 对应后端 /api/portfolios：
 * - GET    /portfolios        — 列表
 * - POST   /portfolios        — 创建
 * - GET    /portfolios/:id    — 详情
 * - PATCH  /portfolios/:id    — 更新
 * - DELETE /portfolios/:id    — 删除（级联）
 */

import { http } from '@/lib/api-client';
import type {
  CreatePortfolioRequest,
  PortfolioResponse,
  UpdatePortfolioRequest,
} from './types';

/** 获取当前用户的所有组合 */
export function listPortfolios(): Promise<PortfolioResponse[]> {
  return http.get<PortfolioResponse[]>('/portfolios');
}

/** 创建组合 */
export function createPortfolio(
  payload: CreatePortfolioRequest,
): Promise<PortfolioResponse> {
  return http.post<PortfolioResponse>('/portfolios', payload);
}

/** 获取组合详情 */
export function getPortfolio(id: string): Promise<PortfolioResponse> {
  return http.get<PortfolioResponse>(`/portfolios/${id}`);
}

/** 更新组合（名称/描述） */
export function updatePortfolio(
  id: string,
  payload: UpdatePortfolioRequest,
): Promise<PortfolioResponse> {
  return http.patch<PortfolioResponse>(`/portfolios/${id}`, payload);
}

/** 删除组合（级联删除子数据） */
export function deletePortfolio(id: string): Promise<null> {
  return http.delete<null>(`/portfolios/${id}`);
}
