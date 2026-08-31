/**
 * api/portfolio.api.ts — 组合管理 API
 *
 * 对应后端 /api/portfolios：
 * - GET    /portfolios        — 列表
 * - POST   /portfolios        — 创建
 * - GET    /portfolios/:id    — 详情
 * - PATCH  /portfolios/:id    — 更新
 * - PATCH  /portfolios/:id/archive — 归档/取消归档
 * - PATCH  /portfolios/:id/default — 切换默认组合（toggle）
 * - DELETE /portfolios/:id    — 删除（级联）
 */

import { http } from '@/lib/api-client';
import type {
  CreatePortfolioRequest,
  PortfolioResponse,
  UpdatePortfolioRequest,
  UserPreference,
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

/** 更新组合（名称/描述） */
export function updatePortfolio(
  id: string,
  payload: UpdatePortfolioRequest,
): Promise<PortfolioResponse> {
  return http.patch<PortfolioResponse>(`/portfolios/${id}`, payload);
}

/** 归档/取消归档组合（archived: true=归档，false=取消归档） */
export function archivePortfolio(
  id: string,
  archived: boolean,
): Promise<PortfolioResponse> {
  return http.patch<PortfolioResponse>(`/portfolios/${id}/archive`, { archived });
}

/** 删除组合（级联删除子数据） */
export function deletePortfolio(id: string): Promise<null> {
  return http.delete<null>(`/portfolios/${id}`);
}

/**
 * 切换默认组合（toggle，项6 · SET-P0-06）
 *
 * 后端 set_default_portfolio 语义：若 portfolioId 已是当前默认则取消（置 null），
 * 否则设为默认。返回更新后的偏好（含 defaultPortfolioId）。
 * 不发送请求体——后端仅依据路径 id 与当前偏好判定，无需额外参数。
 */
export function setDefaultPortfolio(id: string): Promise<UserPreference> {
  return http.patch<UserPreference>(`/portfolios/${id}/default`, {});
}

/** 清空组合全部数据（保留组合本身，SET-P0-05） */
export function clearPortfolioData(id: string): Promise<null> {
  return http.delete<null>(`/portfolios/${id}/data`);
}
