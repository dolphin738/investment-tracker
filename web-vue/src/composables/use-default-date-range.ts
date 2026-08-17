/**
 * composables/use-default-date-range.ts — 全局默认日期范围 composable（I-04）
 *
 * 平移自 React 版 web/src/features/query/use-default-date-range.ts。
 *
 * 语义（架构 §4.3）：
 *   effectiveDefault = URL 携带 range（或 from/to）→ 以 URL 为准（useUrlState 天然满足）
 *                     否则 → UserPreference.defaultDateRange（偏好异步到达后对齐一次）
 *                     偏好为空/首次登录 → '1y'
 *
 * 返回 computed：偏好异步到达后自动重算；消费方必须用「偏好对齐 effect 范式」
 * （URL 无对应参数时 setState 一次）接入，严禁在渲染期依赖未加载偏好。
 */

import { computed } from 'vue';
import { QUICK_RANGE_OPTIONS } from '@/modules/query/quick-range';
import { usePreferenceStore } from '@/stores/preference.store';

/** 系统回落默认值（PRD §6.9.1） */
export const DEFAULT_DATE_RANGE = '1y';

/**
 * 返回有效偏好默认日期范围（非法/空 → '1y'）。
 */
export function useDefaultDateRange() {
  const preferenceStore = usePreferenceStore();
  return computed(() => {
    const prefRange = preferenceStore.getPreference('defaultDateRange');
    const valid = QUICK_RANGE_OPTIONS.some((o) => o.value === prefRange);
    return valid ? prefRange : DEFAULT_DATE_RANGE;
  });
}
