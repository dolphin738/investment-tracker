/**
 * features/holdings/holdings-toolbar.tsx — 持仓页统一筛选器（I-05 · 持仓日期卡片重新设计）
 *
 * 持仓 / 买卖明细 / 分红费用 **三个板块共享同一个筛选器**，位于页面顶部。
 * 承载容器 = 原「持仓日期卡片」升级（rounded-md border p-3 体系）。
 *
 * 筛选维度（架构 §4.4.1）：
 * 1. 快捷范围下拉（7 项 QUICK_RANGE_OPTIONS）+ 自定义起止（DateRangeQuickPicker 口径）—— 买卖明细/分红费用
 * 2. 持仓日期 as-of 单点（label 内化为「持仓日期（as-of）」）—— 持仓板块
 * 3. 证券多选下拉（含已选计数徽标）—— 三板块
 * 4. 场景下拉（买入/卖出/全部）—— 买卖明细→side、分红费用→scenario（持仓不适用置灰）
 * 5. 持仓专属折叠区：类型多选 + 显示已清仓开关（可折叠避免卡片过重）
 *
 * 纯受控组件：状态由 `useUrlState` 持有（URL query 持久化），本组件只负责渲染 + 回调。
 * 零新依赖：多选下拉沿用自绘 checkbox 面板范式。
 */

import { useState } from 'react';
import { Check, ChevronDown, Filter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DateRangeQuickPicker } from '@/components/date/date-range-quick-picker';
import { resolveQuickRange } from '@/features/query/dimension-switcher';
import { todayInAppTzIso } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { SecurityType } from '@investment-tracker/shared';
import { FeeScenario } from '@/api/types';
import type { Security } from '@/api/types';
import { HOLDINGS_TYPE_OPTIONS } from './holdings-query-params';
import type { HoldingsFilterState } from './holdings-query-params';

export interface HoldingsToolbarProps {
  /** 统一筛选器状态（useUrlState 持有） */
  value: HoldingsFilterState;
  /** 状态增量补丁 */
  onChange: (patch: Partial<HoldingsFilterState>) => void;
  /** 持仓日期 as-of 下限（首个交易日；无交易 = 组合创建日） */
  minDate: string;
  /** 「全部」快捷项起始日（Portfolio.baseDate） */
  allRangeStart?: string | null;
  /** 标的多选数据源 */
  securities: Security[];
  /** 偏好默认范围（URL 无 range 时 schema 默认值；仅供回显兜底） */
  defaultRange: string;
  className?: string;
}

export function HoldingsToolbar({
  value,
  onChange,
  minDate,
  allRangeStart,
  securities,
  className,
}: HoldingsToolbarProps): JSX.Element {
  const [secOpen, setSecOpen] = useState(false);
  const [typesOpen, setTypesOpen] = useState(false);
  const [holdingsOpen, setHoldingsOpen] = useState(false);
  const maxDate = todayInAppTzIso();

  // 起止日期回显：range=custom 用 from/to；否则按快捷项解析（含「全部」以 baseDate 为起点）
  const displayRange =
    value.range === 'custom'
      ? { startDate: value.from, endDate: value.to }
      : resolveQuickRange(value.range, {
          allRangeStart: allRangeStart ?? undefined,
        });

  const toggleSecurity = (id: string) => {
    const next = value.sec.includes(id)
      ? value.sec.filter((s) => s !== id)
      : [...value.sec, id];
    onChange({ sec: next });
  };

  const toggleType = (t: SecurityType) => {
    const next = value.types.includes(t)
      ? value.types.filter((x) => x !== t)
      : [...value.types, t];
    onChange({ types: next });
  };

  return (
    <div
      className={cn('rounded-md border border-border p-3', className)}
      data-testid="holdings-unified-filter"
    >
      {/* 标题 + 口径提示（I-05 §6.2.3/6.2.4） */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" />
          统一筛选器
        </p>
        <p className="text-xs text-muted-foreground">
          持仓板块以持仓日期为准，买卖明细 / 分红费用以日期范围为准
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        {/* ① 快捷范围 + 自定义起止（I-05/I-06：必须含 7 项快捷范围） */}
        <DateRangeQuickPicker
          quick={value.range}
          startDate={displayRange.startDate}
          endDate={displayRange.endDate}
          allRangeStart={allRangeStart}
          onChange={(r) =>
            r.quick
              ? onChange({ range: r.quick as HoldingsFilterState['range'], from: '', to: '' })
              : onChange({ range: 'custom', from: r.startDate, to: r.endDate })
          }
        />

        {/* ② 持仓日期（as-of）单点（HOLD-B-P0-11 能力保留：默认今日、范围校验） */}
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">持仓日期（as-of）</Label>
          <Input
            type="date"
            value={value.date}
            min={minDate}
            max={maxDate}
            onChange={(e) => onChange({ date: e.target.value })}
            className="w-[160px]"
          />
        </div>

        {/* ③ 证券多选（含已选计数徽标） */}
        <div className="relative space-y-1.5">
          <Label className="text-xs text-muted-foreground">证券</Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-[150px] justify-between"
            onClick={() => setSecOpen((o) => !o)}
            aria-expanded={secOpen}
          >
            <span className="flex items-center gap-1.5">
              {value.sec.length === 0 ? '全部证券' : `已选 ${value.sec.length} 项`}
              {value.sec.length > 0 && (
                <Badge variant="secondary" className="h-4 min-w-4 px-1 text-[10px]">
                  {value.sec.length}
                </Badge>
              )}
            </span>
            <ChevronDown className="h-3.5 w-3.5 opacity-60" />
          </Button>
          {secOpen && (
            <div className="absolute z-20 mt-1 w-[220px] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
              {securities.length === 0 ? (
                <p className="px-2 py-2 text-xs text-muted-foreground">
                  暂无标的
                </p>
              ) : (
                securities.map((sec) => {
                  const checked = value.sec.includes(sec.id);
                  return (
                    <label
                      key={sec.id}
                      className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-muted"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSecurity(sec.id)}
                        className="h-3.5 w-3.5 accent-primary"
                      />
                      <span className="flex-1 truncate">
                        {sec.name}
                        <span className="ml-1 text-xs text-muted-foreground">
                          {sec.code}
                        </span>
                      </span>
                      {checked && <Check className="h-3.5 w-3.5 text-primary" />}
                    </label>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* ④ 场景下拉（买入/卖出/全部；持仓板块不适用，I-05 §6.2.2） */}
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">场景</Label>
          <Select
            value={value.scenario}
            onValueChange={(v) => onChange({ scenario: v as HoldingsFilterState['scenario'] })}
          >
            <SelectTrigger className="w-[110px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              <SelectItem value={FeeScenario.BUY}>买入</SelectItem>
              <SelectItem value={FeeScenario.SELL}>卖出</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* ⑤ 持仓专属折叠区：类型多选 + 显示已清仓 */}
        <div className="space-y-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9 px-2 text-xs text-muted-foreground"
            onClick={() => setHoldingsOpen((o) => !o)}
            aria-expanded={holdingsOpen}
          >
            {holdingsOpen ? '收起' : '展开'}持仓选项
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 transition-transform',
                holdingsOpen && 'rotate-180',
              )}
            />
          </Button>
          {holdingsOpen && (
            <div className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-muted/20 p-2">
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
                    {value.types.length === 0 ? '全部类型' : `已选 ${value.types.length} 项`}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 opacity-60" />
                </Button>
                {typesOpen && (
                  <div className="absolute z-20 mt-1 w-[180px] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
                    {HOLDINGS_TYPE_OPTIONS.map((opt) => {
                      const checked = value.types.includes(opt.value);
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

              <div className="flex items-center gap-2 pb-1.5">
                <Switch
                  id="holdings-include-closed"
                  checked={value.closed}
                  onCheckedChange={(v) => onChange({ closed: v })}
                />
                <Label
                  htmlFor="holdings-include-closed"
                  className="cursor-pointer text-sm"
                >
                  显示已清仓
                </Label>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
