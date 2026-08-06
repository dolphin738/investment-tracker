/**
 * components/date/date-range-quick-picker.tsx — 日期范围 + 快捷范围选择器（T-7）
 *
 * 【定位】列表页筛选栏的通用日期区间控件。把「快捷范围下拉 + 起止日期输入」
 * 这一组合抽成单一组件，供资产记录页 / 出入金页 / 现金余额变更历史等复用，
 * 避免各页各写一份、样式与口径分头漂移（问题⑤⑥⑦）。
 *
 * 【与 DimensionSwitcher 的分工】
 * - `DimensionSwitcher`：分析页专用，含维度 Tabs + 聚合方式 + 日期范围，重量级。
 * - 本组件：只管日期范围，列表页用；两者共用同一份 `QUICK_RANGE_OPTIONS` 与
 *   `resolveQuickRange`，口径唯一真相源仍在 dimension-switcher.tsx。
 *
 * 【受控】startDate / endDate 由父级持有；任何变更都通过 onChange 回传。
 *
 * 【交互契约】
 * - 选中快捷项 → 按 `resolveQuickRange(v, { allRangeStart })` 覆盖起止日期，
 *   回调携带 `quick` 便于父级写 URL。
 * - 手动改起止日期 → 回调 `quick: undefined`，同时下拉回落占位（当前区间已不再
 *   等于任一预设，继续高亮预设会误导）。
 * - 「全部」起始日 = `allRangeStart`（组合首个交易日 baseDate），缺省回落
 *   `ALL_RANGE_FALLBACK_START`（问题②）。
 *
 * 【布局】统一 `space-y-1.5` + `Label(text-xs) + Input/Select(h-9)` 结构，
 * 与 snapshot-list / transactions 现有筛选项同高，`items-end` 下天然一排对齐。
 */

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  QUICK_RANGE_OPTIONS,
  resolveQuickRange,
  type QuickRangeOption,
} from '@/features/query/dimension-switcher';
import { cn } from '@/lib/utils';

/** onChange 回传的区间 */
export interface DateRangeValue {
  /** 起始日期 YYYY-MM-DD（空串 = 不限） */
  startDate: string;
  /** 结束日期 YYYY-MM-DD（空串 = 不限） */
  endDate: string;
  /**
   * 本次变更命中的快捷项 value（如 '1m' / 'all'）。
   * 手动编辑起止日期时为 `undefined`，父级可据此清除 URL 上的 range 参数。
   */
  quick?: string;
}

export interface DateRangeQuickPickerProps {
  /** 起始日期 YYYY-MM-DD（受控，空串 = 不限） */
  startDate: string;
  /** 结束日期 YYYY-MM-DD（受控，空串 = 不限） */
  endDate: string;
  /** 区间变更回调 */
  onChange: (range: DateRangeValue) => void;
  /**
   * 「全部」的起始日 —— 传 `usePortfolioBaseDate()`（组合首个交易日）。
   * 缺省 / null 回落 2000-01-01（问题②）。
   */
  allRangeStart?: string | null;
  /** 快捷范围选项（缺省 = 共享的 7 项 QUICK_RANGE_OPTIONS） */
  quickRanges?: ReadonlyArray<QuickRangeOption>;
  /** 起始日期输入的 label（缺省「起始日期」） */
  startLabel?: string;
  /** 结束日期输入的 label（缺省「结束日期」） */
  endLabel?: string;
  className?: string;
}

/** Select 占位值（Radix Select 不允许空字符串 value，用哨兵值渲染占位） */
const QUICK_RANGE_PLACEHOLDER = '__none__';

export function DateRangeQuickPicker({
  startDate,
  endDate,
  onChange,
  allRangeStart,
  quickRanges = QUICK_RANGE_OPTIONS,
  startLabel = '起始日期',
  endLabel = '结束日期',
  className,
}: DateRangeQuickPickerProps): JSX.Element {
  // 下拉回显值：选中预设后显示该预设；手动改日期后回落占位
  const [quickRange, setQuickRange] = useState<string>(QUICK_RANGE_PLACEHOLDER);

  /** 选中快捷项：一次性覆盖起止日期 */
  const handleQuickChange = (v: string): void => {
    setQuickRange(v);
    const range = resolveQuickRange(v, {
      allRangeStart: allRangeStart ?? undefined,
    });
    onChange({
      startDate: range.startDate,
      endDate: range.endDate,
      quick: v,
    });
  };

  /** 手动改起始日：下拉回落占位，quick 置空 */
  const handleStartChange = (v: string): void => {
    setQuickRange(QUICK_RANGE_PLACEHOLDER);
    onChange({ startDate: v, endDate, quick: undefined });
  };

  /** 手动改结束日：下拉回落占位，quick 置空 */
  const handleEndChange = (v: string): void => {
    setQuickRange(QUICK_RANGE_PLACEHOLDER);
    onChange({ startDate, endDate: v, quick: undefined });
  };

  return (
    <div className={cn('flex flex-wrap items-end gap-3', className)}>
      {quickRanges.length > 0 && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">快捷范围</Label>
          <Select value={quickRange} onValueChange={handleQuickChange}>
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="选择范围" />
            </SelectTrigger>
            <SelectContent>
              {quickRanges.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">{startLabel}</Label>
        <Input
          type="date"
          value={startDate}
          onChange={(e) => handleStartChange(e.target.value)}
          className="w-[150px]"
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">{endLabel}</Label>
        <Input
          type="date"
          value={endDate}
          onChange={(e) => handleEndChange(e.target.value)}
          className="w-[150px]"
        />
      </div>
    </div>
  );
}
