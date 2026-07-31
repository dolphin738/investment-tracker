/**
 * pages/nav-analysis.tsx — 净值分析页
 *
 * 布局：
 * - 维度切换（日/周/月/年 + 日期范围 + 聚合方式）
 * - 当前净值卡片（累计净值 + 当年净值）
 * - 净值趋势双线对比图
 * - 月度收益热力图（基于日维度数据）
 * - 明细表
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
import { DimensionSwitcher } from '@/features/query/dimension-switcher';
import type { DimensionSwitcherValue } from '@/features/query/dimension-switcher';
import { NavTrendChart } from '@/components/charts/nav-trend-chart';
import { MonthlyHeatmap } from '@/components/charts/monthly-heatmap';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { useNavSeries, useLatestNav } from '@/hooks/use-query-data';
import { formatDecimal, formatPercent, formatDate } from '@/lib/utils';
import { getDefaultDateRange } from '@/lib/constants';
import {
  AggregationMethod,
  QueryGranularity,
} from '@investment-tracker/shared';

export default function NavAnalysisPage(): JSX.Element {
  const currentPortfolioId = usePortfolioStore((s) => s.currentPortfolioId);
  const { startDate, endDate } = getDefaultDateRange();

  const [dimension, setDimension] = useState<DimensionSwitcherValue>({
    granularity: QueryGranularity.MONTH,
    startDate,
    endDate,
    aggregation: AggregationMethod.LAST,
  });

  const series = useNavSeries(currentPortfolioId, dimension);
  const latest = useLatestNav(currentPortfolioId);

  // 热力图使用日维度数据（独立查询）
  const heatmapParams: typeof dimension = {
    ...dimension,
    granularity: QueryGranularity.DAY,
  };
  const heatmapSeries = useNavSeries(
    currentPortfolioId,
    dimension.granularity === QueryGranularity.DAY ? dimension : heatmapParams,
  );

  if (!currentPortfolioId) {
    return (
      <Card className="mx-auto max-w-md">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          请先选择一个投资组合
        </CardContent>
      </Card>
    );
  }

  const seriesData = series.data ?? [];
  const heatmapData = useMemo(
    () => heatmapSeries.data ?? [],
    [heatmapSeries.data],
  );

  const latestCumulativeNav = latest.data?.cumulativeNav ?? null;
  const latestYearNav = latest.data?.yearNav ?? null;
  const latestShares = latest.data?.shares ?? null;
  const totalReturn =
    latestCumulativeNav !== null ? latestCumulativeNav - 1 : null;
  const yearReturn = latestYearNav !== null ? latestYearNav - 1 : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">净值分析</h1>
        <p className="text-sm text-muted-foreground">
          查看累计净值、当年净值趋势及月度收益分布
        </p>
      </div>

      <DimensionSwitcher value={dimension} onChange={setDimension} />

      {/* 当前净值摘要 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>当前累计净值</CardDescription>
            <CardTitle className="text-2xl">
              {formatDecimal(latestCumulativeNav)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">累计收益 {formatPercent(totalReturn)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>当年净值</CardDescription>
            <CardTitle className="text-2xl">
              {formatDecimal(latestYearNav)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">当年收益 {formatPercent(yearReturn)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>当前份额</CardDescription>
            <CardTitle className="text-2xl">
              {latestShares !== null
                ? Number(latestShares).toLocaleString('zh-CN', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })
                : '-'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              {latest.data ? `截至 ${formatDate(latest.data.date)}` : '暂无数据'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>最大回撤</CardDescription>
            <CardTitle className="text-2xl">-</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">P1 阶段开放</p>
          </CardContent>
        </Card>
      </div>

      {/* 净值趋势双线对比 */}
      <NavTrendChart
        data={seriesData}
        loading={series.isLoading}
        title="净值趋势（累计 + 当年双线对比）"
      />

      {/* 月度收益热力图 */}
      <MonthlyHeatmap
        data={heatmapData}
        loading={heatmapSeries.isLoading}
        title="月度收益热力图"
      />

      {/* 明细表 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">每日净值明细</CardTitle>
          <CardDescription>当前维度下的明细数据</CardDescription>
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
                  <TableHead className="text-right">累计净值</TableHead>
                  <TableHead className="text-right">当年净值</TableHead>
                  <TableHead className="text-right">份额</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...seriesData].reverse().map((p, idx) => (
                  <TableRow key={`${p.date}-${idx}`}>
                    <TableCell className="font-mono text-sm">{p.label}</TableCell>
                    <TableCell className="text-right font-mono">
                      {formatDecimal(p.cumulativeNav)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatDecimal(p.yearNav)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {p.shares !== null
                        ? Number(p.shares).toLocaleString('zh-CN', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })
                        : '-'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
