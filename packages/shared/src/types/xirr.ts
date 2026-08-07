/**
 * DailyXirr（每日 XIRR）类型 —— **归并转发模块**（T01 共享类型去重）
 *
 * 【为什么只剩转发】
 * `DailyXirr` / `XirrSeriesPoint` / `PortfolioSummary` 曾在两处各写一份：
 * - `packages/shared/src/types.ts`（**包入口 `src/index.ts` 唯一 re-export 的那份**）
 * - 本文件（仅被 `src/types/index.ts` barrel 引用，包 `exports` 未暴露该子路径）
 *
 * 两份声明字段一致却各自维护，属典型「双真相源」隐患。本次统一以
 * `../types.ts` 为**唯一真相源**，本文件退化为 type-only 转发，保证
 * `src/types/index.ts` 的 `export * from './xirr.ts'` 行为完全不变。
 *
 * 【语义备忘（原文档保留）】
 * XIRR = 扩展内部收益率，求解使所有现金流 NPV = 0 的年化折现率 r。
 * 现金流：买入=负，卖出=正，当日资产快照=正终值。
 * xirr_value 为小数形式（如 0.12345678 表示 12.34%），
 * 全同号现金流时为 null（数据不足或无法求解）。精度 NUMERIC(10,8)。
 *
 * ⚠️ 请勿在此新增声明；新增/修改一律去 `packages/shared/src/types.ts`。
 */

export type {
  /** 每日 XIRR 记录实体（对应 Prisma model DailyXirr） */
  DailyXirr,
  /** XIRR 时间序列数据点（GET /portfolios/:portfolioId/xirr，按 granularity 聚合） */
  XirrSeriesPoint,
  /** 组合统计摘要（GET /portfolios/:portfolioId/summary · Dashboard 卡片） */
  PortfolioSummary,
} from '../types.ts';
