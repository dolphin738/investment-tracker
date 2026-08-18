/**
 * api/security-trade.api.ts — 证券买卖流水 API
 *
 * 对应后端 /api/portfolios/:portfolioId/security-trades：
 * - GET    /security-trades          — 列表（分页 + 日期范围 + 标的筛选）
 * - POST   /security-trades          — 创建
 * - GET    /security-trades/:id      — 单条
 * - PATCH  /security-trades/:id      — 编辑
 * - DELETE /security-trades/:id      — 删除
 *
 * 方案B：SecurityTrade 是持仓推导唯一来源，写入会触发后端净值/XIRR 重算。
 */

import { http } from '@/lib/api-client';
import type {
  CreateSecurityTradeRequest,
  PaginatedResponse,
  SecurityTradeQuery,
  SecurityTradeResponse,
  UpdateSecurityTradeRequest,
} from './types';

/** 获取证券买卖流水列表（分页） */
export function listSecurityTrades(
  portfolioId: string,
  query: SecurityTradeQuery = {},
): Promise<PaginatedResponse<SecurityTradeResponse>> {
  return http.get<PaginatedResponse<SecurityTradeResponse>>(
    `/portfolios/${portfolioId}/security-trades`,
    { params: query },
  );
}

/** 创建证券买卖流水 */
export function createSecurityTrade(
  portfolioId: string,
  payload: CreateSecurityTradeRequest,
): Promise<SecurityTradeResponse> {
  return http.post<SecurityTradeResponse>(
    `/portfolios/${portfolioId}/security-trades`,
    payload,
  );
}

/** 更新证券买卖流水 */
export function updateSecurityTrade(
  portfolioId: string,
  id: string,
  payload: UpdateSecurityTradeRequest,
): Promise<SecurityTradeResponse> {
  return http.patch<SecurityTradeResponse>(
    `/portfolios/${portfolioId}/security-trades/${id}`,
    payload,
  );
}

/** 删除证券买卖流水 */
export function deleteSecurityTrade(
  portfolioId: string,
  id: string,
): Promise<null> {
  return http.delete<null>(
    `/portfolios/${portfolioId}/security-trades/${id}`,
  );
}
