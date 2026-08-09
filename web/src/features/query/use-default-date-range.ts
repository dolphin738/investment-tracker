/**
 * features/query/use-default-date-range.ts — 全局默认日期范围 hook（I-04）
 *
 * 语义（架构 §4.3）：
 *   effectiveDefault = URL 携带 range（或 from/to）→ 以 URL 为准（useUrlState 天然满足）
 *                     否则 → UserPreference.defaultDateRange（偏好异步到达后对齐一次）
 *                     偏好为空/首次登录 → '1y'
 *
 * 用法：
 * - 返回偏好中的有效 range 值（'1w'|'1m'|'3m'|'6m'|'1y'|'ytd'|'all'），非法/空回落 '1y'；
 * - 各页把它作为 useState/useUrlState 默认值，并按「偏好对齐 effect 范式」
 *   （URL 无对应参数时 setState 一次）接入 —— 严禁在渲染期依赖未加载偏好。
 *
 * 单一真相源：QUICK_RANGE_OPTIONS（叶子模块 ./quick-range；dimension-switcher
 * 仅做向后兼容的再导出，本 hook 直接取叶子模块以免把组件拖进依赖图）。
 */

import { QUICK_RANGE_OPTIONS } from './quick-range';
import { usePreferenceStore } from '@/stores/preference.store';

/** 系统回落默认值（PRD §6.9.1） */
export const DEFAULT_DATE_RANGE = '1y';

/**
 * 返回有效偏好默认日期范围（非法/空 → '1y'）。
 *
 * ⚠️ 注意：此 hook 读取 preference.store，偏好是异步加载的 —— 首帧通常返回
 * DEFAULT_PREFERENCES.defaultDateRange（'1y'），偏好到达后重渲染返回服务端值。
 * 消费方必须用 effect 对齐一次，不能依赖渲染期值（架构 §8 偏好对齐 effect 范式）。
 */
export function useDefaultDateRange(): string {
  const getPreference = usePreferenceStore((s) => s.getPreference);
  const prefRange = getPreference('defaultDateRange');
  const valid = QUICK_RANGE_OPTIONS.some((o) => o.value === prefRange);
  return valid ? prefRange : DEFAULT_DATE_RANGE;
}
