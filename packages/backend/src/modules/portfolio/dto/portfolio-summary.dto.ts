/**
 * 组合摘要 DTO
 *
 * 用于 GET /api/portfolios/summary 返回全部组合摘要列表。
 * 供概览页对比（DASH-P1-01）+ 账户页列表（ACC-P0-04）共用。
 */

/**
 * 单个组合摘要
 *
 * 精度契约（与 overview.service 完全一致，见 docs/incremental-account-v2.md D2）：
 * - 金额 2 位小数、净值 6 位、收益率 8 位，一律以 string 跨网（禁止转 number 序列化）
 * - 「无数据」一律用 null，禁止用 0 / '' 冒充
 * - 收益率是**比率**（0.0523 = 5.23%），前端 formatPercent 负责 ×100
 */
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

  // ===== Gap A 新增（ACC-P0-03 / ACC-P0-04）=====
  /** 组合成立日 = 首笔存入日（FIN-D6）YYYY-MM-DD；null = 尚无存入，组合未成立 */
  baseDate: string | null;
  /** 组合币种（v1 恒为 CNY） */
  currency: string;
  /** 组合创建时间 ISO 8601（baseDate 为 null 时供前端展示「创建于 …」） */
  createdAt: string;
  /** 最新累计净值，6 位小数字符串；null = 尚无 DailyNav */
  cumulativeNav: string | null;
  /** 当年收益率（**比率**，非百分数）= yearNav - 1，8 位小数字符串；null = 尚无 DailyNav */
  yearReturnRate: string | null;
  /** 净投入 = Σ存入(BUY) - Σ取出(SELL)，2 位小数字符串；无出入金记录 = '0.00' */
  netInvested: string;
  /** 浮动盈亏 = totalAsset - netInvested，2 位小数字符串；null = 无总资产快照 */
  floatingProfit: string | null;
}

/** 全部组合摘要响应 */
export type PortfolioSummaryResponse = PortfolioSummaryDto[];
