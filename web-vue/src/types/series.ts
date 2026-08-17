/**
 * types/series.ts — 图表 / ECharts 展示类型（number 版）。
 *
 * 后端返回 string（NavPointOut / XirrPointOut，字段名 value / cumulativeNav 等），
 * 由 `api/query.api.ts` 在取数边界用 `toNumberOrNull`（策略 A · §5.2 退役）统一转换为
 * 本文件类型。这些类型是 number 视图类型，不属契约常量，故从 `lib/types.ts` 迁出（§5.2b）。
 */

/** 净值时间序列数据点 */
export interface NavSeriesPoint {
  date: string;
  cumulativeNav: number | null;
  yearNav: number | null;
  shares: number | null;
  label: string;
}

/** XIRR 时间序列数据点 */
export interface XirrSeriesPoint {
  date: string;
  xirrValue: number | null;
  label: string;
}
