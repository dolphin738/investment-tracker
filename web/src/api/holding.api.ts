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
import { SecurityType } from '@/lib/types';
import type { HoldingResponse, HoldingsAggregate } from './types';

export interface HoldingQueryParams {
  /** 推导日期 YYYY-MM-DD，缺省为今天 */
  date?: string;
  /** 仅返回该标的 */
  securityId?: string;
  /** 是否包含已清仓标的 */
  includeClosed?: boolean;
  /** 按标的类型筛选（后端 holding.controller 白名单校验） */
  types?: SecurityType[];
}

/** 获取持仓列表（含汇总） */
export function listHoldings(
  portfolioId: string,
  params: HoldingQueryParams = {},
): Promise<{ items: HoldingResponse[]; aggregate: HoldingsAggregate }> {
  // 类型筛选：后端按逗号分隔字符串接收（白名单校验在后端 holding 端点），
  // 故将 SecurityType[] 数组序列化为 "STOCK,FUND"，避免 axios 以重复 key 发送而被后端忽略。
  const query: Record<string, unknown> = { ...params };
  if (Array.isArray(params.types) && params.types.length > 0) {
    query.types = params.types.join(',');
  } else {
    delete query.types;
  }
  return http.get<{ items: HoldingResponse[]; aggregate: HoldingsAggregate }>(
    `/portfolios/${portfolioId}/holdings`,
    { params: query },
  );
}
