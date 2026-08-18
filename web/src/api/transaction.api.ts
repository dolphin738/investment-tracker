/**
 * api/transaction.api.ts — 交易管理 API
 *
 * 对应后端 /api/portfolios/:portfolioId/cashflows：
 * - GET    /cashflows          — 列表（分页 + 日期范围）
 * - POST   /cashflows          — 录入
 * - GET    /cashflows/:id      — 单笔
 * - PATCH  /cashflows/:id      — 编辑
 * - DELETE /cashflows/:id      — 删除
 */

import { http } from '@/lib/api-client';
import type {
  CreateTransactionRequest,
  PaginatedResponse,
  TransactionDeleteResponse,
  TransactionQuery,
  TransactionResponse,
  UpdateTransactionRequest,
} from './types';

/**
 * 获取交易列表（分页 + 筛选 + 排序）
 *
 * URL query 透传白名单（对齐后端 CashFlowQueryDto，避免 forbidNonWhitelisted 400）：
 *   startDate / endDate / types / sortBy / sortOrder / page / pageSize
 * `types` 数组序列化为逗号分隔（Part E-2：`types=BUY,SELL`）；空数组不发送（= 全部）。
 */
export function listTransactions(
  portfolioId: string,
  query: TransactionQuery = {},
): Promise<PaginatedResponse<TransactionResponse>> {
  const params: Record<string, unknown> = { ...query };
  if (Array.isArray(query.types) && query.types.length > 0) {
    params.types = query.types.join(',');
  } else {
    delete params.types;
  }
  return http.get<PaginatedResponse<TransactionResponse>>(
    `/portfolios/${portfolioId}/cashflows`,
    { params },
  );
}

/** 录入交易 */
export function createTransaction(
  portfolioId: string,
  payload: CreateTransactionRequest,
): Promise<TransactionResponse> {
  return http.post<TransactionResponse>(
    `/portfolios/${portfolioId}/cashflows`,
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
    `/portfolios/${portfolioId}/cashflows/${id}`,
    payload,
  );
}

/** 删除交易（F3：后端返回 { recalculation }；旧后端返回 null 时前端兜底） */
export function deleteTransaction(
  portfolioId: string,
  id: string,
): Promise<TransactionDeleteResponse | null> {
  return http.delete<TransactionDeleteResponse | null>(
    `/portfolios/${portfolioId}/cashflows/${id}`,
  );
}
