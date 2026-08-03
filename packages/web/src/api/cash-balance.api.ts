/**
 * api/cash-balance.api.ts — 现金余额 API
 *
 * 对应后端 /api/portfolios/:portfolioId/cash-balances：
 * - POST   /cash-balances     — 录入/覆盖现金余额（同日期覆盖旧值）
 * - GET    /cash-balances     — 列表（分页 + 日期范围）
 * - DELETE /cash-balances/:id — 删除余额记录
 *
 * 方案B：CashBalance 独立手工维护，asOf ≤ 目标日期的最后一条为当前现金余额。
 */

import { http } from '@/lib/api-client';
import type {
  CashBalanceQuery,
  CashBalanceResponse,
  PaginatedResponse,
  UpsertCashBalanceRequest,
} from './types';

/** 录入/覆盖现金余额 */
export function upsertCashBalance(
  portfolioId: string,
  payload: UpsertCashBalanceRequest,
): Promise<CashBalanceResponse> {
  return http.post<CashBalanceResponse>(
    `/portfolios/${portfolioId}/cash-balances`,
    payload,
  );
}

/** 查询现金余额列表 */
export function listCashBalances(
  portfolioId: string,
  query: CashBalanceQuery = {},
): Promise<PaginatedResponse<CashBalanceResponse>> {
  return http.get<PaginatedResponse<CashBalanceResponse>>(
    `/portfolios/${portfolioId}/cash-balances`,
    { params: query },
  );
}

/** 删除现金余额记录 */
export function deleteCashBalance(
  portfolioId: string,
  id: string,
): Promise<null> {
  return http.delete<null>(
    `/portfolios/${portfolioId}/cash-balances/${id}`,
  );
}

/**
 * 获取最新现金余额（后端按 asOf 倒序，pageSize=1 即最新一条）。
 * 语义 = 当前生效现金余额；无记录返回 null。
 */
export function getLatestCashBalance(
  portfolioId: string,
): Promise<CashBalanceResponse | null> {
  return listCashBalances(portfolioId, { page: 1, pageSize: 1 }).then(
    (r) => r.items[0] ?? null,
  );
}
