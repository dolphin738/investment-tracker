/**
 * api/dividend.api.ts — 分红记录 API
 *
 * 对应后端 /api/portfolios/:portfolioId/dividends：
 * - GET    /dividends         — 分红列表
 * - POST   /dividends         — 新增分红
 * - DELETE /dividends/:id     — 删除分红
 */

import { http } from '@/lib/api-client';
import type {
  DividendRecord,
  CreateDividendRecordDto,
} from './types';

/** 获取分红记录列表 */
export function listDividends(portfolioId: string): Promise<DividendRecord[]> {
  return http.get<DividendRecord[]>(
    `/portfolios/${portfolioId}/dividends`,
  );
}

/** 新增分红记录 */
export function createDividend(
  portfolioId: string,
  payload: CreateDividendRecordDto,
): Promise<DividendRecord> {
  return http.post<DividendRecord>(
    `/portfolios/${portfolioId}/dividends`,
    payload,
  );
}

/** 删除分红记录 */
export function deleteDividend(
  portfolioId: string,
  id: string,
): Promise<null> {
  return http.delete<null>(
    `/portfolios/${portfolioId}/dividends/${id}`,
  );
}
