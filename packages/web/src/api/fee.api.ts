/**
 * api/fee.api.ts — 费用记录 API
 *
 * 对应后端 /api/portfolios/:portfolioId/fees：
 * - GET    /fees          — 费用列表（securityId 多值 / scenario / 日期范围 / grouped=1 聚合）
 * - POST   /fees          — 新增费用（scenario 缺省按 transactionId 推断）
 * - PATCH  /fees/:id      — 编辑费用（I-03：修正场景/金额等）
 * - DELETE /fees/:id      — 删除费用
 */

import { http } from '@/lib/api-client';
import type {
  FeeGroupedRow,
  FeeQuery,
  FeeRecord,
  CreateFeeRecordDto,
  UpdateFeeRecordDto,
} from './types';

/** 获取费用记录列表（grouped=1 时返回聚合行） */
export function listFees(
  portfolioId: string,
  query: FeeQuery = {},
): Promise<FeeRecord[] | FeeGroupedRow[]> {
  return http.get<FeeRecord[] | FeeGroupedRow[]>(
    `/portfolios/${portfolioId}/fees`,
    {
      params: {
        ...(query.securityId ? { securityId: query.securityId } : {}),
        ...(query.scenario ? { scenario: query.scenario } : {}),
        ...(query.startDate ? { startDate: query.startDate } : {}),
        ...(query.endDate ? { endDate: query.endDate } : {}),
        ...(query.grouped ? { grouped: '1' } : {}),
      },
    },
  );
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

/** 编辑费用记录（I-03 · PATCH） */
export function updateFee(
  portfolioId: string,
  id: string,
  payload: UpdateFeeRecordDto,
): Promise<FeeRecord> {
  return http.patch<FeeRecord>(
    `/portfolios/${portfolioId}/fees/${id}`,
    payload,
  );
}

/** 删除费用记录 */
export function deleteFee(portfolioId: string, id: string): Promise<null> {
  return http.delete<null>(`/portfolios/${portfolioId}/fees/${id}`);
}
