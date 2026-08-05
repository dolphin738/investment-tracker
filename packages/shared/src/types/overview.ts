/**
 * Overview（概览聚合）类型定义
 *
 * 对应后端 `GET /api/portfolios/:portfolioId/overview` 的响应片段。
 *
 * 本文件只承载**新鲜度（freshness）**契约：概览页顶部「数据新鲜度提示条」
 * （PRD DASH-P1-03 / AL-015）所需的全部判定结果。
 *
 * 🔴 铁律：新鲜度判定**只在后端做**（阈值比较、滞后天数、文案生成），
 * 前端一律只渲染，不得自行用 `latestDate`（快照日期）二次判定 —— 旧口径
 * 已被废弃（快照日期 ≠ 行情/现金的实际更新时间）。
 */

/** 新鲜度提示的来源类别 */
export const FreshnessKind = {
  /** 行情（SecurityPrice.asOf）滞后 */
  PRICE: 'PRICE',
  /** 现金余额（CashBalance.asOf）滞后 */
  CASH: 'CASH',
} as const;

/** 新鲜度提示的来源类别（'PRICE' | 'CASH'） */
export type FreshnessKind = (typeof FreshnessKind)[keyof typeof FreshnessKind];

/**
 * 单条「数据不新鲜」的原因
 *
 * 后端仅在**确实超过阈值**时才产出该条目：不超阈值 → 数组中不出现。
 * 前端渲染 banner 时直接用 `label`；用 `kind` 决定跳转按钮
 * （PRICE → 持仓页更新行情，CASH → 现金流页更新现金余额）。
 */
export interface FreshnessReason {
  /** 来源类别 */
  kind: FreshnessKind;
  /** 该来源的最新数据日期 YYYY-MM-DD；无数据记录（如持仓标的缺行情）→ null */
  asOf: string | null;
  /**
   * 该来源滞后天数（asOf → 今天，UTC+8 口径）。
   * 有 asOf 时为自然数；**无数据记录时为 null**（如持仓标的完全无行情）。
   */
  lagDays: number | null;
  /** 已本地化的展示文案，如「行情已 4 天未更新」/「部分持仓标的无行情数据，请更新现价」 */
  label: string;
}

/**
 * 数据新鲜度聚合信息
 *
 * 判定口径（PRD DASH-P1-03，已采纳决策 O-6）：
 * - `latestPriceAsOf` = **当前持仓标的中最落后的那只**的最新行情日期
 *   （`MIN(MAX(SecurityPrice.asOf) per held security)`）——只要有一只没更新就算陈旧。
 * - `latestCashAsOf` = 该组合 `MAX(CashBalance.asOf)`。
 * - `lagDays` = 该 asOf 距「今天」（后端 `todayInAppTz()`，UTC+8）的自然日天数。
 * - `isStale` = 任一 `lagDays > staleDays`。
 */
export interface FreshnessInfo {
  /** 陈旧阈值（天），取自 `UserPreference.staleDays`，默认 3 */
  staleDays: number;
  /** 是否存在任一来源滞后超过阈值 */
  isStale: boolean;
  /** 持仓标的中最落后的行情日期 YYYY-MM-DD；无持仓 / 无任何行情记录 → null */
  latestPriceAsOf: string | null;
  /** 行情滞后天数；`latestPriceAsOf` 为 null 时同为 null */
  latestPriceLagDays: number | null;
  /** 最新现金余额生效日 YYYY-MM-DD；无记录 → null */
  latestCashAsOf: string | null;
  /** 现金余额滞后天数；`latestCashAsOf` 为 null 时同为 null */
  latestCashLagDays: number | null;
  /** 超过阈值的原因清单；未超阈值时为空数组（**不是 null**） */
  reasons: FreshnessReason[];
}
