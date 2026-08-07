/**
 * pages/xirr-analysis.tsx — 收益分析页（PRD §7.5）
 *
 * - 维度切换 [日][周][月][年] + 范围
 * - 当前累计 XIRR + 较年初
 * - XIRR 趋势折线图（null 断线不画 0 → connectNulls=false）
 * - 年度 XIRR 柱状图
 * - 明细表（日期/XIRR/环比变化）
 */

import { useMemo, useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DimensionSwitcher,
  toDimensionQueryParams,
} from '@/features/query/dimension-switcher';
import type { DimensionSwitcherValue } from '@/features/query/dimension-switcher';
import {
  QUICK_RANGE_OPTIONS,
  resolveQuickRange,
} from '@/features/query/quick-range';
import { useDefaultDateRange } from '@/features/query/use-default-date-range';
import { useRangePreferenceSync } from '@/hooks/use-range-preference-sync';
import { XirrTrendChart } from '@/components/charts/xirr-trend-chart';
import { YearlyBarChart } from '@/components/charts/yearly-bar-chart';
import {
  usePortfolioBaseDate,
  usePortfolioStore,
} from '@/stores/portfolio.store';
import { usePreferenceStore } from '@/stores/preference.store';
import { useXirrSeries, useLatestXirr, useYearStartXirr } from '@/hooks/use-query-data';
import { formatPercent, formatChange, formatDate } from '@/lib/utils';
import {
  AggregationMethod,
  QueryGranularity,
  type XirrSeriesPoint,
} from '@investment-tracker/shared';

export default function XirrAnalysisPage(): JSX.Element {
  const currentPortfolioId = usePortfolioStore((s) => s.currentPortfolioId);
  // 「全部」快捷项的起点 = 组合首个交易日（问题②）
  const baseDate = usePortfolioBaseDate();
  // I-04：默认日期范围 = 偏好（URL 无 range 参数时），非法/空回落 '1y'
  const defaultRange = useDefaultDateRange();
  const initialRange = useMemo(
    () =>
      resolveQuickRange(defaultRange, {
        allRangeStart: baseDate ?? undefined,
      }),
    [defaultRange, baseDate],
  );

  // 维度初始值（SET-P0-02 验收 4：读取偏好 defaultGranularity 作为默认维度）
  const getPreference = usePreferenceStore((s) => s.getPreference);
  const xirrDecimals = getPreference('xirrDecimals');
  const [dimension, setDimension] = useState<DimensionSwitcherValue>({
    granularity: getPreference('defaultGranularity') as QueryGranularity,
    startDate: initialRange.startDate,
    endDate: initialRange.endDate,
    aggregation: AggregationMethod.LAST,
    // INC-01：快捷范围受控回显，首帧取偏好回落值（'1y'），偏好到达后由对齐 effect 纠正
    quick: defaultRange,
  });

  /**
   * 偏好对齐守卫（INC-01 决策 E · 统一范式）。
   *
   * 取代原先「每次 defaultRange/baseDate 变化就无条件 setDimension」的写法 ——
   * 那会在用户手动改过范围后把选择弹回偏好默认值（持仓页曾踩过的 QA Bug）。
   */
  const { markInteracted } = useRangePreferenceSync({
    currentQuick: dimension.quick ?? '',
    currentStartDate: dimension.startDate,
    allRangeStart: baseDate,
    urlParamKeys: ['range', 'startDate', 'endDate'],
    onAlign: (alignment) =>
      setDimension((prev) => ({
        ...prev,
        quick: alignment.quick,
        startDate: alignment.startDate,
        endDate: alignment.endDate,
      })),
  });

  /** 维度/范围变更入口：改动了日期范围即标记用户交互（此后不再被偏好对齐覆盖） */
  const handleDimensionChange = (next: DimensionSwitcherValue): void => {
    if (
      next.quick !== dimension.quick ||
      next.startDate !== dimension.startDate ||
      next.endDate !== dimension.endDate
    ) {
      markInteracted();
    }
    setDimension(next);
  };

  // 🔴 必须剥离 quick（纯 UI 回显字段）：后端 ValidationPipe forbidNonWhitelisted 会 400
  const seriesParams = useMemo(() => toDimensionQueryParams(dimension), [dimension]);
  const series = useXirrSeries(currentPortfolioId, seriesParams);
  const latest = useLatestXirr(currentPortfolioId);
  // 较年初基准：独立日粒度查询当年首个非空 XIRR（ANL-P0-04 / Part E-6），
  // 与页面维度/范围解耦 —— 修复旧实现「查询范围不含年初时基准错」的缺陷（Part A2）
  const yearStartQuery = useYearStartXirr(currentPortfolioId);

  if (!currentPortfolioId) {
    return (
      <Card className="mx-auto max-w-md">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          请先选择一个投资组合
        </CardContent>
      </Card>
    );
  }

  const seriesData: XirrSeriesPoint[] = series.data ?? [];
  const currentValue = latest.data?.xirrValue ?? null;

  const yearStartValue = yearStartQuery.data ?? null;
  const changeFromYearStart = formatChange(currentValue, yearStartValue, xirrDecimals);

  // 年度聚合数据（用于柱状图）
  const yearlyData: XirrSeriesPoint[] = seriesData.filter(
    (p) => dimension.granularity !== QueryGranularity.YEAR,
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">收益分析（XIRR）</h1>
        <p className="text-sm text-muted-foreground">
          查看累计 XIRR 在不同时间维度下的趋势与年度对比
        </p>
      </div>

      {/*
        问题③：与净值分析页（nav-analysis）保持同一外层结构。
        DimensionSwitcher 内部是 `md:justify-between`——作为**全宽块级元素**时会把
        起止日期推到最右端，与净值页的左对齐观感不一致。包一层 flex 容器后它变成
        「按内容收缩」的 flex item，justify-between 失去多余空间从而不再生效，
        日期控件紧跟维度 Tabs 左对齐。
      */}
      <div className="flex flex-wrap items-end gap-4">
        <DimensionSwitcher
          value={dimension}
          onChange={handleDimensionChange}
          quickRanges={QUICK_RANGE_OPTIONS}
          allRangeStart={baseDate}
        />
      </div>

      {/* 当前累计 XIRR + 较年初 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>当前累计 XIRR</CardDescription>
            <CardTitle className="text-3xl">
              {formatPercent(currentValue, 2, { decimals: xirrDecimals })}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              {latest.data ? `最新日期 ${formatDate(latest.data.date)}` : '暂无数据'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>较年初变化</CardDescription>
            <CardTitle className="text-3xl">
              {changeFromYearStart}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">单位：百分点（pp）</p>
          </CardContent>
        </Card>
      </div>

      {/* XIRR 折线图（null 断线） */}
      <XirrTrendChart
        data={seriesData}
        loading={series.isLoading}
        title={`XIRR 趋势 — ${labelOf(dimension.granularity)}`}
        connectNulls={false}
      />

      {/* 年度柱状图（当年柱高亮，DASH-P1-05 验收 2） */}
      {dimension.granularity !== QueryGranularity.YEAR && yearlyData.length > 0 && (
        <YearlyBarChart
          data={aggregateByYear(seriesData)}
          title="年度 XIRR 对比"
          highlightCurrentYear
        />
      )}

      {/* 明细表 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">明细数据</CardTitle>
          <CardDescription>XIRR 与环比变化</CardDescription>
        </CardHeader>
        <CardContent>
          {series.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : seriesData.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              暂无数据
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>日期</TableHead>
                  <TableHead>XIRR</TableHead>
                  <TableHead>环比变化</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...seriesData].reverse().map((p, idx) => {
                  const prev = seriesData[seriesData.length - idx - 2];
                  return (
                    <TableRow key={`${p.date}-${idx}`}>
                      <TableCell className="font-mono text-sm">
                        {p.label}
                      </TableCell>
                      <TableCell className="font-mono">
                        {formatPercent(p.xirrValue, 2, { decimals: xirrDecimals })}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {formatChange(p.xirrValue, prev?.xirrValue ?? null, xirrDecimals)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function labelOf(g: QueryGranularity): string {
  switch (g) {
    case QueryGranularity.DAY:
      return '按日';
    case QueryGranularity.WEEK:
      return '按周';
    case QueryGranularity.MONTH:
      return '按月';
    case QueryGranularity.YEAR:
      return '按年';
    default:
      return '';
  }
}

/** 简单按年份分组的聚合（取每年最后一条非空 XIRR） */
function aggregateByYear(data: XirrSeriesPoint[]): XirrSeriesPoint[] {
  const map = new Map<number, XirrSeriesPoint>();
  for (const p of data) {
    const year = Number(p.date.slice(0, 4));
    if (Number.isNaN(year)) continue;
    const existing = map.get(year);
    if (!existing || p.date > existing.date) {
      map.set(year, { ...p, label: String(year) });
    }
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, p]) => p);
}
