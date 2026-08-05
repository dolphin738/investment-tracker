/**
 * features/holdings/holdings-toolbar.tsx — 持仓页工具栏（T02 · HOLD-B-P0-04 / P0-11）
 *
 * - 日期选择器（默认今天，可选范围 [首个交易日, 今天]）
 * - 「显示已清仓」开关（includeClosed）
 * - 标的类型多选（全不选 = 全部；按钮徽标显示已选数）
 *
 * 纯受控组件：状态由 `useUrlState` 持有（URL query 持久化），本组件只负责渲染 + 回调。
 * 零新依赖：日期用原生 `<Input type="date">`，多选下拉用原生 checkbox + 轻量自绘面板
 * （不为一个选择器引 react-day-picker / radix-popover）。
 */

import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { todayInAppTzIso } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { SecurityType } from '@investment-tracker/shared';
import { HOLDINGS_TYPE_OPTIONS } from './holdings-query-params';

export interface HoldingsToolbarProps {
  /** 当前推导日期 YYYY-MM-DD */
  date: string;
  /** 可选范围下限（首个交易日；无交易 = 组合创建日） */
  minDate: string;
  /** 是否显示已清仓 */
  includeClosed: boolean;
  /** 类型多选（空 = 全部） */
  types: SecurityType[];
  onDateChange: (value: string) => void;
  onClosedChange: (value: boolean) => void;
  onTypesChange: (value: SecurityType[]) => void;
  className?: string;
}

export function HoldingsToolbar({
  date,
  minDate,
  includeClosed,
  types,
  onDateChange,
  onClosedChange,
  onTypesChange,
  className,
}: HoldingsToolbarProps): JSX.Element {
  const [typesOpen, setTypesOpen] = useState(false);
  const maxDate = todayInAppTzIso();
  const selectedCount = types.length;

  const toggleType = (value: SecurityType) => {
    const next = types.includes(value)
      ? types.filter((t) => t !== value)
      : [...types, value];
    onTypesChange(next);
  };

  return (
    <div
      className={cn(
        'flex flex-wrap items-end gap-3 rounded-md border border-border p-3',
        className,
      )}
    >
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">持仓日期</Label>
        <Input
          type="date"
          value={date}
          min={minDate}
          max={maxDate}
          onChange={(e) => onDateChange(e.target.value)}
          className="w-[160px]"
        />
      </div>

      <div className="flex items-center gap-2 pb-1.5">
        <Switch
          id="holdings-include-closed"
          checked={includeClosed}
          onCheckedChange={onClosedChange}
        />
        <Label
          htmlFor="holdings-include-closed"
          className="cursor-pointer text-sm"
        >
          显示已清仓
        </Label>
      </div>

      <div className="relative space-y-1.5">
        <Label className="text-xs text-muted-foreground">类型</Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-[140px] justify-between"
          onClick={() => setTypesOpen((o) => !o)}
          aria-expanded={typesOpen}
        >
          <span>
            {selectedCount === 0 ? '全部类型' : `已选 ${selectedCount} 项`}
          </span>
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </Button>
        {typesOpen && (
          <div className="absolute z-20 mt-1 w-[180px] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
            {HOLDINGS_TYPE_OPTIONS.map((opt) => {
              const checked = types.includes(opt.value);
              return (
                <label
                  key={opt.value}
                  className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-muted"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleType(opt.value)}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  <span className="flex-1">{opt.label}</span>
                  {checked && <Check className="h-3.5 w-3.5 text-primary" />}
                </label>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
