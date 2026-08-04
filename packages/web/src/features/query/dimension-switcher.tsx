/**
 * features/query/dimension-switcher.tsx — 维度切换 + 日期范围选择
 *
 * 用于 XIRR 分析页、净值分析页：
 * - Tabs 切换 granularity（日/周/月/年）
 * - 日期范围选择（startDate / endDate）
 * - 聚合方式切换（期末值/平均值）
 * - 快捷范围下拉（可选 prop `quickRanges`，缺省不渲染，DASH-P0-02 快捷项）
 *
 * 受控组件：value + onChange，由父页面持有状态。
 */

import { useState } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AGGREGATION_OPTIONS, GRANULARITY_OPTIONS, toIsoDate } from '@/lib/constants';
import { cn } from '@/lib/utils';
import type {
  AggregationMethod,
  QueryGranularity,
} from '@investment-tracker/shared';

export interface DimensionSwitcherValue {
  granularity: QueryGranularity;
  startDate?: string;
  endDate?: string;
  aggregation: AggregationMethod;
}

export interface QuickRangeOption {
  value: string;
  label: string;
}

export interface DimensionSwitcherProps {
  value: DimensionSwitcherValue;
  onChange: (value: DimensionSwitcherValue) => void;
  /** 是否显示聚合方式切换（默认 true） */
  showAggregation?: boolean;
  /**
   * 快捷范围预设（如 近3月/近1年/今年至今/全部）。
   * 缺省不渲染；选中后按预设计算起止日期并回调 onChange。
   */
  quickRanges?: ReadonlyArray<QuickRangeOption>;
  className?: string;
}

/** 快捷范围计算（对齐 dashboard DATE_RANGE_OPTIONS 口径） */
function resolveQuickRange(
  range: string,
): { startDate?: string; endDate?: string } {
  const end = new Date();
  const endStr = toIsoDate(end);
  const start = new Date();
  switch (range) {
    case '3m':
      start.setMonth(start.getMonth() - 3);
      return { startDate: toIsoDate(start), endDate: endStr };
    case '1y':
      start.setFullYear(start.getFullYear() - 1);
      return { startDate: toIsoDate(start), endDate: endStr };
    case 'ytd':
      return { startDate: `${end.getFullYear()}-01-01`, endDate: endStr };
    // 'all' = 成立日至今：startDate 固定 2000-01-01（对齐 dashboard DATE_RANGE_OPTIONS 口径），
    // 必须显式返回 startDate，否则合并时 ?? value.startDate 会保留旧起始日，范围不扩大。
    case 'all':
      return { startDate: '2000-01-01', endDate: endStr };
    default:
      return {};
  }
}

/** Select 占位值（Radix Select 不允许空字符串 value，用哨兵值渲染占位） */
const QUICK_RANGE_PLACEHOLDER = '__none__';

export function DimensionSwitcher({
  value,
  onChange,
  showAggregation = true,
  quickRanges,
  className,
}: DimensionSwitcherProps): JSX.Element {
  // 最近一次选中的快捷项（仅作 Select 回显；用户手动改日期后不回退，仍显示上次预设）
  const [quickRange, setQuickRange] = useState<string>(QUICK_RANGE_PLACEHOLDER);

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

        {quickRanges && quickRanges.length > 0 && (
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">快捷范围</Label>
            <Select
              value={quickRange}
              onValueChange={(v) => {
                setQuickRange(v);
                const range = resolveQuickRange(v);
                onChange({
                  ...value,
                  startDate: range.startDate ?? value.startDate,
                  endDate: range.endDate ?? value.endDate,
                });
              }}
            >
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
      </div>

      <div className="flex items-end gap-2">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">起始日期</Label>
          <Input
            type="date"
            value={value.startDate ?? ''}
            onChange={(e) =>
              onChange({ ...value, startDate: e.target.value || undefined })
            }
            className="w-[160px]"
          />
        </div>
        <span className="pb-2 text-muted-foreground">~</span>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">结束日期</Label>
          <Input
            type="date"
            value={value.endDate ?? ''}
            onChange={(e) =>
              onChange({ ...value, endDate: e.target.value || undefined })
            }
            className="w-[160px]"
          />
        </div>
      </div>
    </div>
  );
}
