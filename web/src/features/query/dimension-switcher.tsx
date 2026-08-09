/**
 * features/query/dimension-switcher.tsx — 维度切换 + 聚合方式（+ 内嵌统一日期范围控件）
 *
 * 用于 XIRR 分析页、净值分析页：
 * - Tabs 切换 granularity（日/周/月/年）
 * - 聚合方式切换（期末值/平均值）
 * - 日期范围：**内嵌全站唯一控件 `DateRangeQuickPicker`**（INC-01 决策 G）
 *
 * 【INC-01 改造要点】
 * 改造前本组件自带一套「快捷范围 Select + 起止 Input(w-[160px]) + `~` 分隔符」，
 * 与列表页的 `DateRangeQuickPicker`（w-[150px]、无分隔符、标签文案不同）视觉/交互
 * 双轨，属决策 G 明令消除的「第二套控件」。改造后：
 * - 删除内嵌 Select / Input / 私有 `quickRange` useState；
 * - 日期范围整体交给 `DateRangeQuickPicker`，宽度、标签、占位、交互全站唯一；
 * - 快捷项回显改为**受控**：`value.quick` 由父页面持有，配合
 *   `useRangePreferenceSync` 完成偏好默认值对齐（决策 E）。
 *
 * 【口径常量迁移】`QUICK_RANGE_OPTIONS` / `resolveQuickRange` / `ALL_RANGE_FALLBACK_START`
 * 等已下沉到叶子模块 `./quick-range`（打断 dimension-switcher ↔ date-range-quick-picker
 * 的循环依赖）。本文件继续 **原样 re-export**，所有既有 `from '@/features/query/dimension-switcher'`
 * 的 import 保持可用，无需改动调用方。
 *
 * 受控组件：value + onChange，由父页面持有状态。
 */

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DateRangeQuickPicker } from '@/components/date/date-range-quick-picker';
import { QUICK_RANGE_OPTIONS } from './quick-range';
// 说明：下方 `export type { QuickRangeOption } from './quick-range'` 是**再导出**，
// 不产生本地绑定；此处 import 才引入可用于类型标注的本地名，两者不冲突。
import type { QuickRangeOption } from './quick-range';
import { AGGREGATION_OPTIONS, GRANULARITY_OPTIONS } from '@/lib/constants';
import { cn } from '@/lib/utils';
import type {
  AggregationMethod,
  QueryGranularity,
} from '@/lib/types';

// ── 快捷范围口径（唯一真相源在 ./quick-range，此处原样 re-export 保持向后兼容）──
export {
  QUICK_RANGE_OPTIONS,
  QUICK_RANGE_PLACEHOLDER,
  ALL_RANGE_FALLBACK_START,
  resolveQuickRange,
  isQuickRangeValue,
} from './quick-range';
export type {
  QuickRangeOption,
  ResolvedDateRange,
  ResolveQuickRangeOptions,
} from './quick-range';

export interface DimensionSwitcherValue {
  granularity: QueryGranularity;
  /**
   * 起始日期 YYYY-MM-DD。
   *
   * 空值语义统一为**空串 `''`**（INC-01：与 `DateRangeQuickPicker` 对齐）；
   * `undefined` 仍被接受（历史状态），渲染时按 `?? ''` 处理。
   */
  startDate?: string;
  /** 结束日期 YYYY-MM-DD，空值语义同 {@link DimensionSwitcherValue.startDate} */
  endDate?: string;
  aggregation: AggregationMethod;
  /**
   * 当前命中的快捷范围值（如 '1y' / 'all'），受控回显用。
   *
   * - 空串 `''` / `undefined` / 未命中预设 → 下拉显示占位「选择范围」；
   * - 用户手动改起止日期时本字段被置空（自定义区间不再高亮任何预设）。
   */
  quick?: string;
}

/**
 * 剥离仅用于 UI 回显的 `quick` 字段，得到可直接下发后端的查询参数。
 *
 * 🔴 **必须调用**：后端全局 `ValidationPipe` 开启了 `forbidNonWhitelisted`
 * （`backend/src/main.ts`），把 `DimensionSwitcherValue` 原样当作查询参数
 * 透传（如 `useXirrSeries(id, dimension)`）会因多出 `quick` 键被 400 拒绝。
 *
 * @param value 维度切换器的受控值
 * @returns 去掉 `quick` 后的查询参数（granularity / startDate / endDate / aggregation）
 */
export function toDimensionQueryParams(
  value: DimensionSwitcherValue,
): Omit<DimensionSwitcherValue, 'quick'> {
  const params = { ...value };
  delete params.quick;
  return params;
}

export interface DimensionSwitcherProps {
  value: DimensionSwitcherValue;
  onChange: (value: DimensionSwitcherValue) => void;
  /** 是否显示聚合方式切换（默认 true） */
  showAggregation?: boolean;
  /**
   * 快捷范围预设（如 近3月/近1年/今年/全部）。
   * 缺省 = 共享的 7 项 {@link QUICK_RANGE_OPTIONS}；传 `[]` 可隐藏快捷下拉。
   */
  quickRanges?: ReadonlyArray<QuickRangeOption>;
  /**
   * 「全部」快捷项的起始日 —— 传当前组合首个交易日（`Portfolio.baseDate`，问题②）。
   * 缺省或为 null 时回落 `ALL_RANGE_FALLBACK_START`。
   */
  allRangeStart?: string | null;
  className?: string;
}

export function DimensionSwitcher({
  value,
  onChange,
  showAggregation = true,
  quickRanges = QUICK_RANGE_OPTIONS,
  allRangeStart,
  className,
}: DimensionSwitcherProps): JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 md:flex-row md:items-end md:justify-between',
        className,
      )}
    >
      <div className="flex items-end gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">维度</Label>
          <Tabs
            value={value.granularity}
            onValueChange={(v) =>
              onChange({ ...value, granularity: v as QueryGranularity })
            }
          >
            <TabsList>
              {GRANULARITY_OPTIONS.map((opt) => (
                <TabsTrigger key={opt.value} value={opt.value}>
                  {opt.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        {showAggregation && (
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">聚合方式</Label>
            <Select
              value={value.aggregation}
              onValueChange={(v) =>
                onChange({
                  ...value,
                  aggregation: v as AggregationMethod,
                })
              }
            >
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AGGREGATION_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {/* 日期范围：全站唯一控件（INC-01 决策 G），受控 quick 回显 */}
      <DateRangeQuickPicker
        quick={value.quick ?? ''}
        startDate={value.startDate ?? ''}
        endDate={value.endDate ?? ''}
        quickRanges={quickRanges}
        allRangeStart={allRangeStart}
        onChange={(range) =>
          onChange({
            ...value,
            startDate: range.startDate,
            endDate: range.endDate,
            // 手动改起止日期时 range.quick 为 undefined → 落回空串（自定义区间）
            quick: range.quick ?? '',
          })
        }
      />
    </div>
  );
}
