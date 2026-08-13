/**
 * api/portfolio-price.api.ts — 组合行情刷新进度 / 最新 fetched_at 与来源（路径 B 收尾轮询）
 *
 * 对应后端 modules/portfolio/router.py：
 * - GET /api/portfolios/{portfolio_id}/prices/sync-status
 *   → { last_fetched_at: string|null, source: string|null }
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

/** 读取某组合的行情同步状态 */
export function getPriceSyncStatus(
  portfolioId: string,
): Promise<PriceSyncStatus> {
  return http.get<PriceSyncStatus>(
    `/portfolios/${encodeURIComponent(portfolioId)}/prices/sync-status`,
  );
}
