/**
 * api/transaction.api.ts — 交易管理 API
 *
 * 对应后端 /api/portfolios/:portfolioId/transactions：
 * - GET    /transactions          — 列表（分页 + 日期范围）
 * - POST   /transactions          — 录入
 * - GET    /transactions/:id      — 单笔
 * - PATCH  /transactions/:id      — 编辑
 * - DELETE /transactions/:id      — 删除
 */

import { http } from '@/lib/api-client';
import type {
  CreateTransactionRequest,
  PaginatedResponse,
  TransactionQuery,
  TransactionResponse,
  UpdateTransactionRequest,
} from './types';

/** 获取交易列表（分页） */
export function listTransactions(
  portfolioId: string,
  query: TransactionQuery = {},
): Promise<PaginatedResponse<TransactionResponse>> {
  return http.get<PaginatedResponse<TransactionResponse>>(
    `/portfolios/${portfolioId}/transactions`,
    { params: query },
  );
}

/** 录入交易 */
export function createTransaction(
  portfolioId: string,
  payload: CreateTransactionRequest,
): Promise<TransactionResponse> {
  return http.post<TransactionResponse>(
    `/portfolios/${portfolioId}/transactions`,
    payload,
  );
}

/** 编辑交易 */
export function updateTransaction(
  portfolioId: string,
  id: string,
  payload: UpdateTransactionRequest,
): Promise<TransactionResponse> {
  return http.patch<TransactionResponse>(
    `/portfolios/${portfolioId}/transactions/${id}`,
    payload,
  );
}

/** 删除交易 */
export function deleteTransaction(
  portfolioId: string,
  id: string,
): Promise<null> {
  return http.delete<null>(`/portfolios/${portfolioId}/transactions/${id}`);
}
