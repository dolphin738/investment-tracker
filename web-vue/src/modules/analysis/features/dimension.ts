/**
 * modules/analysis/features/dimension.ts — 维度切换器的值类型与查询参数剥离
 *
 * 平移自 React 版 web/src/features/query/dimension-switcher.tsx 的纯类型/纯函数部分。
 * 组件实现见 components/DimensionSwitcher.vue。
 */

import type { AggregationMethod, QueryGranularity } from '@/lib/types';

/** 维度切换器受控值（由父页面持有） */
export interface DimensionSwitcherValue {
  granularity: QueryGranularity;
  /**
   * 起始日期 YYYY-MM-DD。
   *
   * 空值语义统一为空串 ''（与 DateRangeQuickPicker 对齐）；
   * undefined 仍被接受（历史状态），渲染时按 ?? '' 处理。
   */
  startDate?: string;
  /** 结束日期 YYYY-MM-DD，空值语义同 startDate */
  endDate?: string;
  aggregation: AggregationMethod;
  /**
   * 当前命中的快捷范围值（如 '1y' / 'all'），受控回显用。
   *
   * - 空串 '' / undefined / 未命中预设 → 下拉显示占位「选择范围」；
   * - 用户手动改起止日期时本字段被置空（自定义区间不再高亮任何预设）。
   */
  quick?: string;
}

/**
 * 剥离仅用于 UI 回显的 quick 字段，得到可直接下发后端的查询参数。
 *
 * 必须调用：后端全局 ValidationPipe 开启了 forbidNonWhitelisted，
 * 把 DimensionSwitcherValue 原样当作查询参数透传会因多出 quick 键被 400 拒绝。
 *
 * @param value 维度切换器的受控值
 * @returns 去掉 quick 后的查询参数（granularity / startDate / endDate / aggregation）
 */
export function toDimensionQueryParams(
  value: DimensionSwitcherValue,
): Omit<DimensionSwitcherValue, 'quick'> {
  const params = { ...value };
  delete params.quick;
  return params;
}
