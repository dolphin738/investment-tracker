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

/**
 * 快捷范围预设（DASH-P0-02 / 决策 Q-6 乙：7 项，唯一真相源）。
 *
 * 概览页、净值分析页、XIRR 分析页共用此常量与 resolveQuickRange，
 * 不再各自维护本地副本，避免口径漂移。
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
  /**
   * 「全部」快捷项的起始日 —— 传当前组合首个交易日（`Portfolio.baseDate`，问题②）。
   * 缺省或为 null 时回落 {@link ALL_RANGE_FALLBACK_START}。
   */
  allRangeStart?: string | null;
  className?: string;
}

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

/** Select 占位值（Radix Select 不允许空字符串 value，用哨兵值渲染占位） */
const QUICK_RANGE_PLACEHOLDER = '__none__';

export function DimensionSwitcher({
  value,
  onChange,
  showAggregation = true,
  quickRanges,
  allRangeStart,
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
                // resolveQuickRange 恒返回具体起止日期，直接覆盖即可
                // 「全部」以组合首个交易日为起点（问题②），未传则回落兜底值
                const range = resolveQuickRange(v, {
                  allRangeStart: allRangeStart ?? undefined,
                });
                onChange({
                  ...value,
                  startDate: range.startDate,
                  endDate: range.endDate,
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
