/**
 * hooks/use-range-preference-sync.ts — 日期范围「偏好默认值」对齐守卫（INC-01 · 决策 E）
 *
 * 【背景】
 * `UserPreference.defaultDateRange` 是**异步**到达的（preference.store 首帧回落
 * `'1y'`）。各页若在渲染期直接用偏好值会闪烁；若无脑用 effect 回写又会出现
 * 「用户刚选的范围被偏好默认值弹回」的 bug（QA 第 1 轮已踩过）。
 *
 * 持仓页 `HoldingsPage` 沉淀出的正确范式是：
 *   1. `useDefaultDateRange()` 取偏好有效值（非法/空 → `'1y'`）
 *   2. 一个 **交互守卫 ref**：用户一旦手动改过范围，此后 effect 永不再对齐
 *   3. 一个 **URL 参数守卫**：URL 显式带了 range/from/to 时以 URL 为准，不对齐
 *   4. 对齐 effect：仅在「无 URL 参数 且 用户未交互 且 当前值 ≠ 偏好值」时写一次
 *
 * 本 hook 把这套范式抽出来，供 INC-01 要求统一的 5 个页面复用：
 * 概览 / 出入金 / 资产记录 / 现金余额历史 / 净值分析 / XIRR 分析（+ 持仓页参照）。
 *
 * 【适配三种状态载体】
 * 页面状态可能存在 `useUrlState`、`useSearchParams` 或本地 `useState` 里。
 * 本 hook **不持有**页面状态，只负责「什么时候该对齐、对齐成什么值」，
 * 通过 `onAlign` 回调把结果交回页面自己写入 —— 三种载体都能接。
 *
 * 【使用契约（🔴 必须遵守）】
 * - 页面**每一个**会改变日期范围的用户操作（选快捷项 / 改起止日期 / 点重置）
 *   都必须调用返回的 `markInteracted()`，否则对齐 effect 会把用户选择弹回去。
 * - `currentQuick` 传页面当前的快捷范围值，空串 `''` 表示「不限 / 自定义」。
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  resolveQuickRange,
  type ResolvedDateRange,
} from '@/features/query/quick-range';
import { useDefaultDateRange } from '@/features/query/use-default-date-range';

/** 对齐回调载荷：快捷项 + 已解析的具体起止日期（页面按自己的载体挑用） */
export interface RangePreferenceAlignment extends ResolvedDateRange {
  /** 应当写入页面状态的快捷范围值（如 '1y' / 'all'） */
  quick: string;
}

/** URL 上代表「用户显式指定了范围」的默认参数名 */
export const DEFAULT_RANGE_URL_PARAM_KEYS: readonly string[] = [
  'range',
  'from',
  'to',
];

export interface UseRangePreferenceSyncOptions {
  /**
   * 页面当前的快捷范围值。
   *
   * 空串 `''` = 不限 / 自定义（尚未对齐过），`'custom'` 亦视为用户自定义。
   */
  currentQuick: string;
  /**
   * 对齐回调 —— 把偏好默认范围写入页面状态。
   *
   * 内部以 ref 保存最新引用，**无需**用 `useCallback` 包裹。
   */
  onAlign: (alignment: RangePreferenceAlignment) => void;
  /**
   * 「全部」快捷项的起始日（组合首个交易日 `Portfolio.baseDate`）。
   * 缺省 / null 回落 `ALL_RANGE_FALLBACK_START`。
   */
  allRangeStart?: string | null;
  /**
   * 页面当前的起始日期（可选）。
   *
   * 仅用于 `defaultRange === 'all'` 的二次对齐：`baseDate` 是异步到达的，
   * 首次对齐可能用了兜底起点 `2000-01-01`；baseDate 到位后需再对齐一次，
   * 否则「全部」的起点会永远停在兜底值。
   */
  currentStartDate?: string;
  /**
   * URL 参数名白名单：任一存在即认为「用户通过链接显式指定了范围」，跳过对齐。
   * 缺省 {@link DEFAULT_RANGE_URL_PARAM_KEYS}；传 `[]` 表示不做 URL 判定。
   */
  urlParamKeys?: readonly string[];
  /** 是否启用对齐（如依赖数据未就绪时可传 false 延后），默认 true */
  enabled?: boolean;
}

export interface UseRangePreferenceSyncResult {
  /** 偏好中的有效默认范围（非法/空 → '1y'） */
  defaultRange: string;
  /** 挂载时 URL 是否已显式携带范围参数（携带则全程不对齐） */
  hasUrlRangeParam: boolean;
  /** 用户是否已手动改过范围（只读快照，主要用于调试 / 断言） */
  hasInteracted: boolean;
  /** 🔴 页面每次「用户主动改范围」都必须调用 */
  markInteracted: () => void;
}

/** 读取挂载瞬间的 URL 是否含范围参数（SSR / 非浏览器环境安全） */
function readHasUrlParam(keys: readonly string[]): boolean {
  if (keys.length === 0) return false;
  if (typeof window === 'undefined') return false;
  const search = new URLSearchParams(window.location.search);
  return keys.some((key) => search.has(key));
}

/**
 * 日期范围偏好对齐守卫（决策 E 统一范式）。
 *
 * @example
 * ```tsx
 * const [range, setRange] = useState({ quick: '', startDate: '', endDate: '' });
 * const { markInteracted } = useRangePreferenceSync({
 *   currentQuick: range.quick,
 *   currentStartDate: range.startDate,
 *   allRangeStart: baseDate,
 *   onAlign: (a) => setRange({ quick: a.quick, startDate: a.startDate, endDate: a.endDate }),
 * });
 *
 * <DateRangeQuickPicker
 *   quick={range.quick}
 *   startDate={range.startDate}
 *   endDate={range.endDate}
 *   onChange={(r) => { markInteracted(); setRange({ quick: r.quick ?? '', ...r }); }}
 * />
 * ```
 */
export function useRangePreferenceSync({
  currentQuick,
  onAlign,
  allRangeStart = null,
  currentStartDate,
  urlParamKeys = DEFAULT_RANGE_URL_PARAM_KEYS,
  enabled = true,
}: UseRangePreferenceSyncOptions): UseRangePreferenceSyncResult {
  const defaultRange = useDefaultDateRange();

  // 交互守卫：用户一旦主动改过范围，此后永不对齐（避免选择被弹回）
  const interactedRef = useRef<boolean>(false);

  // onAlign 以 ref 保存最新引用，避免调用方内联箭头函数导致 effect 反复触发
  const onAlignRef = useRef(onAlign);
  useEffect(() => {
    onAlignRef.current = onAlign;
  });

  // URL 参数守卫：只读挂载瞬间的快照（与 HoldingsPage 既有范式一致）
  const urlParamKeysToken = urlParamKeys.join(',');
  const hasUrlRangeParam = useMemo(
    () => readHasUrlParam(urlParamKeysToken ? urlParamKeysToken.split(',') : []),
    [urlParamKeysToken],
  );

  const markInteracted = useCallback((): void => {
    interactedRef.current = true;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (hasUrlRangeParam || interactedRef.current) return;
    // 'custom' 不是可解析的预设，偏好不应把页面推向自定义态
    if (!defaultRange || defaultRange === 'custom') return;

    const resolved = resolveQuickRange(defaultRange, {
      allRangeStart: allRangeStart ?? undefined,
    });

    if (currentQuick === defaultRange) {
      // 已经对齐；仅「全部」需要在 baseDate 异步到达后再纠正一次起点
      const needsAllStartFix =
        defaultRange === 'all' &&
        currentStartDate !== undefined &&
        currentStartDate !== resolved.startDate;
      if (!needsAllStartFix) return;
    }

    onAlignRef.current({
      quick: defaultRange,
      startDate: resolved.startDate,
      endDate: resolved.endDate,
    });
  }, [
    enabled,
    hasUrlRangeParam,
    defaultRange,
    currentQuick,
    currentStartDate,
    allRangeStart,
  ]);

  return {
    defaultRange,
    hasUrlRangeParam,
    hasInteracted: interactedRef.current,
    markInteracted,
  };
}
