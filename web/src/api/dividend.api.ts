/**
 * api/dividend.api.ts — 分红记录 API
 *
 * 对应后端 /api/portfolios/:portfolioId/dividends：
 * - GET    /dividends            — 分红列表
 * - POST   /dividends            — 新增分红
 * - PATCH  /dividends/:id        — 编辑分红（增量设计 R-5）
 * - DELETE /dividends/:id        — 删除分红
 */

import { http } from '@/lib/api-client';
import type {
  DividendRecord,
  CreateDividendRecordDto,
  UpdateDividendRecordDto,
} from './types';

/** 分红查询参数（I-05：标的多值 / 日期范围） */
export interface DividendQuery {
  /** 标的 ID（逗号分隔多值） */
  securityId?: string;
  /** 起始日期 YYYY-MM-DD（含） */
  startDate?: string;
  /** 结束日期 YYYY-MM-DD（含） */
  endDate?: string;
}

/** 获取分红记录列表 */
export function listDividends(
  portfolioId: string,
  query: DividendQuery = {},
): Promise<DividendRecord[]> {
  return http.get<DividendRecord[]>(
    `/portfolios/${portfolioId}/dividends`,
    {
      params: {
        ...(query.securityId ? { securityId: query.securityId } : {}),
        ...(query.startDate ? { startDate: query.startDate } : {}),
        ...(query.endDate ? { endDate: query.endDate } : {}),
      },
    },
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

/** 编辑分红记录（PATCH，全可选字段；后端校验净额 ≥ 0） */
export function updateDividend(
  portfolioId: string,
  id: string,
  payload: UpdateDividendRecordDto,
): Promise<DividendRecord> {
  return http.patch<DividendRecord>(
    `/portfolios/${portfolioId}/dividends/${id}`,
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
