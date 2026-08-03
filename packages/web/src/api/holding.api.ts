/**
 * api/holding.api.ts — 持仓管理 API
 *
 * 对应后端 /api/portfolios/:portfolioId：
 * - GET    /holdings?date=&types=           — 持仓明细（含派生字段 + 汇总）
 * - PUT    /holdings                        — 持仓 upsert
 * - DELETE /holdings/:holdingId             — 删除持仓
 * - GET    /holdings/dates                  — 有持仓数据的日期列表
 * - POST   /holdings/sync-snapshot          — 一键同步至资产快照
 */

import { http } from '@/lib/api-client';
import type {
  HoldingResponse,
  HoldingsAggregate,
  UpsertHoldingDto,
  SecurityType,
} from './types';

export interface HoldingQueryParams {
  date?: string;
  types?: SecurityType[];
}

/** 获取持仓列表（含汇总） */
export function listHoldings(
  portfolioId: string,
  params: HoldingQueryParams = {},
): Promise<{ items: HoldingResponse[]; aggregate: HoldingsAggregate }> {
  return http.get<{ items: HoldingResponse[]; aggregate: HoldingsAggregate }>(
    `/portfolios/${portfolioId}/holdings`,
    { params },
  );
}

/** 持仓 upsert（单条） */
export function upsertHolding(
  portfolioId: string,
  payload: UpsertHoldingDto,
): Promise<HoldingResponse> {
  return http.put<HoldingResponse>(
    `/portfolios/${portfolioId}/holdings`,
    payload,
  );
}

/** 删除持仓记录 */
export function deleteHolding(
  portfolioId: string,
  holdingId: string,
): Promise<null> {
  return http.delete<null>(
    `/portfolios/${portfolioId}/holdings/${holdingId}`,
  );
}

/** 获取有持仓数据的日期列表 */
export function getHoldingDates(portfolioId: string): Promise<string[]> {
  return http.get<string[]>(`/portfolios/${portfolioId}/holdings/dates`);
}

/** 一键同步：持仓合计 → 当日资产快照 + 级联重算 */
export function syncHoldingToSnapshot(
  portfolioId: string,
  date: string,
): Promise<{ snapshot: unknown; affectedDays: number }> {
  return http.post<{ snapshot: unknown; affectedDays: number }>(
    `/portfolios/${portfolioId}/holdings/sync-snapshot`,
    { date },
  );
}
