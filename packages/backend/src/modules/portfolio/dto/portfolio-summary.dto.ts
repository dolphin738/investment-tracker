/**
 * 组合摘要 DTO
 *
 * 用于 GET /api/portfolios/summary 返回全部组合摘要列表。
 * 供概览页对比（DASH-P1-01）+ 账户页列表（ACC-P0-04）共用。
 */

/** 单个组合摘要 */
export interface PortfolioSummaryDto {
  /** 组合 ID */
  id: string;
  /** 组合名称 */
  name: string;
  /** 最新总资产（来自最新 AssetSnapshot） */
  totalAsset: string;
  /** 持仓标的数量（最新日期） */
  holdingsCount: number;
  /** 最近更新时间（快照或持仓的最晚日期） */
  lastUpdatedAt: string | null;
}

/** 全部组合摘要响应 */
export type PortfolioSummaryResponse = PortfolioSummaryDto[];
