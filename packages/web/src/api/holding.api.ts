/**
 * api/holding.api.ts — 持仓查询 API（方案B · 只读）
 *
 * 对应后端 GET /api/portfolios/:portfolioId/holdings：
 * 持仓不落库，由后端按 SecurityTrade 流水实时推导（只读端点）。
 *
 * 方案A 的 upsert/delete/dates/sync-snapshot 端点已删除，
 * SecurityTrade（买卖流水）是持仓唯一来源。
 */

import { http } from '@/lib/api-client';
import type { HoldingResponse, HoldingsAggregate } from './types';

export interface HoldingQueryParams {
  /** 推导日期 YYYY-MM-DD，缺省为今天 */
  date?: string;
  /** 仅返回该标的 */
  securityId?: string;
  /** 是否包含已清仓标的 */
  includeClosed?: boolean;
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
