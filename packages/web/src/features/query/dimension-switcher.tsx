/**
 * features/query/dimension-switcher.tsx — 维度切换 + 日期范围选择
 *
 * 用于 XIRR 分析页、净值分析页：
 * - Tabs 切换 granularity（日/周/月/年）
 * - 日期范围选择（startDate / endDate）
 * - 聚合方式切换（期末值/平均值）
 *
 * 受控组件：value + onChange，由父页面持有状态。
 */

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
import { AGGREGATION_OPTIONS, GRANULARITY_OPTIONS } from '@/lib/constants';
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

export interface DimensionSwitcherProps {
  value: DimensionSwitcherValue;
  onChange: (value: DimensionSwitcherValue) => void;
  /** 是否显示聚合方式切换（默认 true） */
  showAggregation?: boolean;
  className?: string;
}

export function DimensionSwitcher({
  value,
  onChange,
  showAggregation = true,
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
