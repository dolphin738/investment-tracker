/**
 * api/portfolio-price.api.ts — 组合行情刷新 / 最新 fetched_at 与来源
 *
 * 对应后端 modules/portfolio/router.py：
 * - GET  /api/portfolios/{portfolio_id}/prices/sync-status → { last_fetched_at, source }
 * - POST /api/portfolios/{portfolio_id}/prices/sync → { synced, failed, skipped, errors }
 *   （路径 C 同步等待：遍历组合涉及分类，按 code 匹配证券 upsert 最新价）
 *
 * 与 quote-provider.api.ts 保持一致的信封解包风格（http 已解包 data）。
 */

import { http } from '@/lib/api-client';

/** 行情同步状态（后端 sync_status_portfolio_prices 返回） */
export interface PriceSyncStatus {
  /** 最新一条标的价格的抓取时间（ISO 8601），无价格记录时为 null */
  last_fetched_at: string | null;
  /** 最新来源（如 akshare / sina），无记录时为 null */
  source: string | null;
}

/** 行情同步结构化结果（后端 sync_portfolio_prices 同步端点返回） */
export interface PriceSyncResult {
  /** 成功同步的标的价格条数 */
  synced: number;
  /** 失败条数 */
  failed: number;
  /** 跳过的标的价格条数（如无可报价来源） */
  skipped: number;
  /** 失败明细（异常/来源相关，仅诊断用） */
  errors: unknown[];
}

/** 读取某组合的行情同步状态 */
export function getPriceSyncStatus(
  portfolioId: string,
): Promise<PriceSyncStatus> {
  return http.get<PriceSyncStatus>(
    `/portfolios/${encodeURIComponent(portfolioId)}/prices/sync-status`,
  );
}

/** 触发某组合行情同步（路径 C 同步等待，返回 {synced,failed,skipped,errors}） */
export function syncPortfolioPrices(
  portfolioId: string,
): Promise<PriceSyncResult> {
  return http.post<PriceSyncResult>(
    `/portfolios/${encodeURIComponent(portfolioId)}/prices/sync`,
  );
}