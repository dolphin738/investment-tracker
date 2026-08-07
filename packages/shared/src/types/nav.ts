/**
 * DailyNav（每日净值）类型 —— **归并转发模块**（T01 共享类型去重）
 *
 * 【为什么只剩转发】
 * `DailyNav` / `NavSeriesPoint` 曾在 `packages/shared/src/types.ts`（包入口
 * `src/index.ts` re-export 的那份）与本文件各写一份，字段一致却双份维护。
 * 本次统一以 `../types.ts` 为**唯一真相源**，本文件退化为 type-only 转发，
 * `src/types/index.ts` 的 `export * from './nav.ts'` 行为完全不变。
 *
 * 【语义备忘（原文档保留）】
 * 净值法核算：单位净值 unit_nav、累计净值 cumulative_nav、当年净值 year_nav、
 * 份额 shares；出入金通过申购/赎回份额调整，不影响单位净值。
 * 精度：净值 NUMERIC(18,6)，份额 NUMERIC(20,6)。
 *
 * ⚠️ 请勿在此新增声明；新增/修改一律去 `packages/shared/src/types.ts`。
 */

export type {
  /** 每日净值记录实体（对应 Prisma model DailyNav） */
  DailyNav,
  /** 净值时间序列数据点（GET /portfolios/:portfolioId/nav，按 granularity 聚合） */
  NavSeriesPoint,
} from '../types.ts';
