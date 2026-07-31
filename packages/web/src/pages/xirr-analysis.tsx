/**
 * pages/xirr-analysis.tsx — XIRR 分析页
 *
 * 布局：
 * - 维度切换（日/周/月/年 + 日期范围 + 聚合方式）
 * - 当前 XIRR 卡片 + 较年初变化
 * - XIRR 折线图
 * - 年度 XIRR 柱状图
 * - 明细数据表（含环比变化）
 */

import { useState } from 'react';
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
import { DimensionSwitcher } from '@/features/query/dimension-switcher';
import type { DimensionSwitcherValue } from '@/features/query/dimension-switcher';
import { XirrTrendChart } from '@/components/charts/xirr-trend-chart';
import { YearlyBarChart } from '@/components/charts/yearly-bar-chart';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { useXirrSeries, useLatestXirr } from '@/hooks/use-query-data';
import { formatPercent, formatChange, formatDate } from '@/lib/utils';
import { getDefaultDateRange } from '@/lib/constants';
import {
  AggregationMethod,
  QueryGranularity,
  type XirrSeriesPoint,
} from '@investment-tracker/shared';

export default function XirrAnalysisPage(): JSX.Element {
  const currentPortfolioId = usePortfolioStore((s) => s.currentPortfolioId);
  const { startDate, endDate } = getDefaultDateRange();

  const [dimension, setDimension] = useState<DimensionSwitcherValue>({
    granularity: QueryGranularity.MONTH,
    startDate,
    endDate,
    aggregation: AggregationMethod.LAST,
  });

  const series = useXirrSeries(currentPortfolioId, dimension);
  const latest = useLatestXirr(currentPortfolioId);

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
  // 取最新一个非空值与年初第一个非空值对比
  const validPoints = seriesData.filter((p) => p.xirrValue !== null);
  const yearStartValue =
    validPoints.length > 0 ? validPoints[0].xirrValue : null;
  const currentValue = latest.data?.xirrValue ?? null;
  const changeFromYearStart = formatChange(currentValue, yearStartValue);

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

      <DimensionSwitcher value={dimension} onChange={setDimension} />

      {/* 当前 XIRR 摘要 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>当前累计 XIRR</CardDescription>
            <CardTitle className="text-3xl">
              {formatPercent(currentValue)}
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
            <CardDescription>较所选区间起点变化</CardDescription>
            <CardTitle className="text-3xl">
              {changeFromYearStart}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">单位：百分点（pp）</p>
          </CardContent>
        </Card>
      </div>

      {/* XIRR 折线图 */}
      <XirrTrendChart
        data={seriesData}
        loading={series.isLoading}
        title={`XIRR 趋势 — ${labelOf(dimension.granularity)}`}
      />

      {/* 年度柱状图（仅当当前维度不是 year 时展示额外聚合） */}
      {dimension.granularity !== QueryGranularity.YEAR && yearlyData.length > 0 && (
        <YearlyBarChart
          data={aggregateByYear(seriesData)}
          title="年度 XIRR 对比"
        />
      )}

      {/* 明细表 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">明细数据</CardTitle>
          <CardDescription>双线数值与环比变化</CardDescription>
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
                        {formatPercent(p.xirrValue)}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {formatChange(p.xirrValue, prev?.xirrValue ?? null)}
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
