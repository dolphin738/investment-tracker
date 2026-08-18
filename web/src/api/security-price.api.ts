/**
 * api/security-price.api.ts — 标的最新价 API
 *
 * 对应后端 /api/portfolios/:portfolioId/security-prices：
 * - POST   /security-prices     — 录入/覆盖标的最新价（同日期覆盖旧值）
 * - GET    /security-prices     — 列表（分页 + 日期范围 + 标的筛选）
 * - DELETE /security-prices/:id — 删除价格记录
 *
 * 方案B：SecurityPrice 按 asOf 日期向前沿用，写入会触发后端重算。
 */

import { http } from '@/lib/api-client';
import type {
  PaginatedResponse,
  SecurityPriceQuery,
  SecurityPriceResponse,
  UpsertSecurityPriceRequest,
} from './types';

/** 录入/覆盖标的最新价 */
export function upsertSecurityPrice(
  portfolioId: string,
  payload: UpsertSecurityPriceRequest,
): Promise<SecurityPriceResponse> {
  return http.post<SecurityPriceResponse>(
    `/portfolios/${portfolioId}/security-prices`,
    payload,
  );
}

/** 查询标的最新价列表 */
export function listSecurityPrices(
  portfolioId: string,
  query: SecurityPriceQuery = {},
): Promise<PaginatedResponse<SecurityPriceResponse>> {
  return http.get<PaginatedResponse<SecurityPriceResponse>>(
    `/portfolios/${portfolioId}/security-prices`,
    { params: query },
  );
}

/** 删除价格记录 */
export function deleteSecurityPrice(
  portfolioId: string,
  id: string,
): Promise<null> {
  return http.delete<null>(
    `/portfolios/${portfolioId}/security-prices/${id}`,
  );
}
