/**
 * features/query/quick-range.ts — 快捷日期范围口径（唯一真相源，决策 Q-6 乙 / INC-01 决策 G）
 *
 * 【为什么单独成文件（T01 增量）】
 * INC-01 要求 `DimensionSwitcher` 内嵌的第二套日期范围 UI 改为复用全站唯一控件
 * `DateRangeQuickPicker`。而 `DateRangeQuickPicker` 本身要引用 `QUICK_RANGE_OPTIONS`
 * / `resolveQuickRange`——若这两者继续留在 `dimension-switcher.tsx`，就会形成
 * `dimension-switcher → date-range-quick-picker → dimension-switcher` 的循环依赖，
 * 且 `QUICK_RANGE_OPTIONS` 是 `const`（存在 TDZ 风险，不像函数声明可提升）。
 *
 * 因此把「纯口径」下沉到本叶子模块（无任何组件依赖）：
 * - `dimension-switcher.tsx` 与 `date-range-quick-picker.tsx` 同时从这里取；
 * - `dimension-switcher.tsx` 继续 re-export 全部符号，**所有既有 import 路径零改动**。
 *
 * 🔴 口径唯一真相源：本文件。任何页面都不得再维护本地快捷范围副本。
 */

import { toIsoDate } from '@/lib/constants';

/** 快捷范围下拉的单项（value 参与 URL/偏好持久化，禁止随意改动） */
export interface QuickRangeOption {
  value: string;
  label: string;
}

/**
 * 快捷范围预设（DASH-P0-02 / 决策 Q-6 乙：7 项，唯一真相源）。
 *
 * 概览页、持仓页、出入金页、资产记录页、现金余额历史、净值分析页、XIRR 分析页
 * 共用此常量与 {@link resolveQuickRange}，不再各自维护本地副本，避免口径漂移。
 */
export const QUICK_RANGE_OPTIONS: ReadonlyArray<QuickRangeOption> = [
  { value: '1w', label: '近一周' },
  { value: '1m', label: '近1月' },
  { value: '3m', label: '近3月' },
  { value: '6m', label: '近6月' },
  { value: '1y', label: '近1年' },
  { value: 'ytd', label: '今年' },
  { value: 'all', label: '全部' },
];

/** 快捷范围解析结果（起止日期恒为具体值，便于直接下发查询参数） */
export interface ResolvedDateRange {
  startDate: string;
  endDate: string;
}

/** 「全部」起始日兜底值（组合无 baseDate 时使用，等价于「足够早」） */
export const ALL_RANGE_FALLBACK_START = '2000-01-01';

/** resolveQuickRange 可选项 */
export interface ResolveQuickRangeOptions {
  /**
   * 「全部」范围的起始日 —— 传组合首个交易日（`Portfolio.baseDate`）。
   *
   * 缺省时回落 {@link ALL_RANGE_FALLBACK_START}，保持单参调用的向后兼容。
   */
  allRangeStart?: string;
}

/**
 * 快捷范围计算（QUICK_RANGE_OPTIONS 7 项的唯一口径实现，决策 Q-6 乙）。
 *
 * - endDate 恒为今天；startDate 按预设回推。
 * - 'ytd' = 当年 1 月 1 日。
 * - 'all' = **组合首个交易日（baseDate）至今**（问题②）。调用方应传
 *   `opts.allRangeStart = currentPortfolio()?.baseDate`；未传或组合尚无
 *   首笔买入（baseDate=null）时回落 {@link ALL_RANGE_FALLBACK_START}。
 *   startDate 必须显式返回，否则调用方合并时 `?? value.startDate` 会保留
 *   旧起始日，范围不扩大。
 * - 未知值回落「近1年」，与旧 dashboard resolveDateRange 的 default 分支一致。
 *
 * 🔴 opts 保持可选 —— 既有单参调用（含 quick-range.test.ts）行为不变。
 */
export function resolveQuickRange(
  range: string,
  opts?: ResolveQuickRangeOptions,
): ResolvedDateRange {
  const end = new Date();
  const endStr = toIsoDate(end);
  const start = new Date();
  switch (range) {
    case '1w':
      start.setDate(start.getDate() - 7);
      break;
    case '1m':
      start.setMonth(start.getMonth() - 1);
      break;
    case '3m':
      start.setMonth(start.getMonth() - 3);
      break;
    case '6m':
      start.setMonth(start.getMonth() - 6);
      break;
    case '1y':
      start.setFullYear(start.getFullYear() - 1);
      break;
    case 'ytd':
      return { startDate: `${end.getFullYear()}-01-01`, endDate: endStr };
    case 'all':
      return {
        startDate: opts?.allRangeStart || ALL_RANGE_FALLBACK_START,
        endDate: endStr,
      };
    default:
      start.setFullYear(start.getFullYear() - 1);
  }
  return { startDate: toIsoDate(start), endDate: endStr };
}

/**
 * Radix Select 占位哨兵值。
 *
 * Radix 不允许 `value=""`，因此「未选中任何快捷项」统一用此哨兵表示。
 * `DateRangeQuickPicker` 与 `DimensionSwitcher` 共用，避免两处各写一份。
 */
export const QUICK_RANGE_PLACEHOLDER = '__none__';

/** 判定某个值是否命中快捷范围预设（受控回显时用） */
export function isQuickRangeValue(
  value: string | undefined,
  options: ReadonlyArray<QuickRangeOption> = QUICK_RANGE_OPTIONS,
): boolean {
  if (!value) return false;
  return options.some((opt) => opt.value === value);
}
