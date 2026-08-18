/**
 * modules/query/use-default-date-range.ts — 全局默认日期范围 composable（I-04）
 *
 * 平移自 React 版 features/query/use-default-date-range.ts。
 *
 * 语义（架构 §4.3）：
 *   effectiveDefault = URL 携带 range（或起止日期）→ 以 URL 为准（页面 URL 状态天然满足）
 *                     否则 → UserPreference.defaultDateRange（偏好异步到达后对齐一次）
 *                     偏好为空/首次登录 → '1y'
 *
 * 用法：
 * - 返回偏好中的有效 range 值（'1w'|'1m'|'3m'|'6m'|'1y'|'ytd'|'all'）的 computed，
 *   非法/空回落 '1y'；偏好异步到达后 computed 自动重算生效；
 * - 各页把它作为 URL 无 range/日期参数时的兜底值 —— 严禁在渲染期依赖未加载偏好
 *   且不建立响应（Vue 版用 computed 保证偏好到达即生效）。
 *
 * 单一真相源：QUICK_RANGE_OPTIONS（叶子模块 ./quick-range）。
 */

import { computed } from 'vue';
import { QUICK_RANGE_OPTIONS } from './quick-range';
import { usePreferenceStore } from '@/stores/preference.store';

/** 系统回落默认值（PRD §6.9.1） */
export const DEFAULT_DATE_RANGE = '1y';

/**
 * 返回有效偏好默认日期范围（非法/空 → '1y'）的 computed。
 *
 * 注意：此 composable 读取 preference.store，偏好是异步加载的 —— 首帧通常返回
 * DEFAULT_PREFERENCES.defaultDateRange（'1y'），偏好到达后 computed 重算返回服务端值。
 * 消费方必须把它接入响应式链路（computed / 模板），不能一次性取值定格。
 */
export function useDefaultDateRange() {
  const preferenceStore = usePreferenceStore();
  return computed<string>(() => {
    const prefRange = preferenceStore.getPreference('defaultDateRange');
    const valid = QUICK_RANGE_OPTIONS.some((o) => o.value === prefRange);
    return valid ? prefRange : DEFAULT_DATE_RANGE;
  });
}
