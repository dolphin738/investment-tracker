/**
 * api/fee.api.ts — 费用记录 API
 *
 * 对应后端 /api/portfolios/:portfolioId/fees：
 * - GET    /fees         — 费用列表
 * - POST   /fees         — 新增费用
 * - DELETE /fees/:id     — 删除费用
 */

import { http } from '@/lib/api-client';
import type { FeeRecord, CreateFeeRecordDto } from './types';

/** 获取费用记录列表 */
export function listFees(portfolioId: string): Promise<FeeRecord[]> {
  return http.get<FeeRecord[]>(`/portfolios/${portfolioId}/fees`);
}

/** 新增费用记录 */
export function createFee(
  portfolioId: string,
  payload: CreateFeeRecordDto,
): Promise<FeeRecord> {
  return http.post<FeeRecord>(
    `/portfolios/${portfolioId}/fees`,
    payload,
  );
}

/** 删除费用记录 */
export function deleteFee(portfolioId: string, id: string): Promise<null> {
  return http.delete<null>(`/portfolios/${portfolioId}/fees/${id}`);
}
