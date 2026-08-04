/**
 * pages/nav-analysis.tsx — 净值分析页（PRD §7.6）
 *
 * - 维度切换 + 指标单选（累计净值/当年净值/对比）
 * - 当前累计净值/当年净值/累计收益/当年收益
 * - 净值趋势双线图（按指标筛选）
 * - 月度收益热力图（正红负绿色阶）
 * - 每日净值明细表：日期/累计净值/当年净值/每日收益/收益百分比/份额
 *   （每日收益 =（当日累计净值 − 前日累计净值）× 前日份额；正红负绿）
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { DimensionSwitcher, QUICK_RANGE_OPTIONS } from '@/features/query/dimension-switcher';
import type { DimensionSwitcherValue } from '@/features/query/dimension-switcher';
import { NavTrendChart } from '@/components/charts/nav-trend-chart';
import { MonthlyHeatmap } from '@/components/charts/monthly-heatmap';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { usePreferenceStore } from '@/stores/preference.store';
import { useNavSeries, useLatestNav } from '@/hooks/use-query-data';
import { formatDecimal, formatPercent, formatCurrency, formatDate } from '@/lib/utils';
import { getDefaultDateRange } from '@/lib/constants';
import { NavMetric as NavMetricEnum, type NavMetric } from '@/api/types';
import {
  AggregationMethod,
  QueryGranularity,
  type NavSeriesPoint,
} from '@investment-tracker/shared';

/** 指标单选选项 */
const METRIC_OPTIONS = [
  { value: NavMetricEnum.CUMULATIVE, label: '累计净值' },
  { value: NavMetricEnum.YEAR, label: '当年净值' },
  { value: NavMetricEnum.BOTH, label: '对比' },
] as const;

/** 每日明细行（含每日收益/收益百分比） */
interface DailyDetailRow {
  date: string;
  label: string;
  cumulativeNav: number | null;
  yearNav: number | null;
  shares: number | null;
  /** 每日收益 =（当日累计净值 − 前日累计净值）× 前日份额 */
  dailyReturn: number | null;
  /** 收益百分比 =（当日累计净值 − 前日累计净值）/ 前日累计净值 */
  returnRate: number | null;
}

/** 由日维度净值序列计算每日明细（按日期升序计算收益，展示倒序） */
function computeDailyDetails(data: NavSeriesPoint[]): DailyDetailRow[] {
  const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date));
  const rows: DailyDetailRow[] = [];
  let prev: NavSeriesPoint | null = null;
  for (const p of sorted) {
    let dailyReturn: number | null = null;
    let returnRate: number | null = null;
    if (
      prev &&
      p.cumulativeNav !== null &&
      prev.cumulativeNav !== null &&
      prev.shares !== null &&
      Number.isFinite(prev.shares)
    ) {
      const diff = p.cumulativeNav - prev.cumulativeNav;
      dailyReturn = diff * prev.shares;
      if (prev.cumulativeNav !== 0) {
        // 收益%公式等价性（Part E-8 / F10）：
        // PRD「每日收益 / 前一日总资产」= (Δnav × prevShares) / (prevNav × prevShares) = Δnav / prevNav，
        // 与现有 diff / prev.cumulativeNav 数学等价，无需改逻辑。
        // 「前一日」= 前一个有记录的计算日（稀疏日期下的金融口径近似，F10 已确认维持现状）。
        returnRate = diff / prev.cumulativeNav;
      }
    }
    rows.push({
      date: p.date,
      label: p.label,
      cumulativeNav: p.cumulativeNav,
      yearNav: p.yearNav,
      shares: p.shares,
      dailyReturn,
      returnRate,
    });
    prev = p;
  }
  return rows.reverse();
}

export default function NavAnalysisPage(): JSX.Element {
  const currentPortfolioId = usePortfolioStore((s) => s.currentPortfolioId);
  const { startDate, endDate } = getDefaultDateRange();

  // 维度初始值（SET-P0-02 验收 4：读取偏好 defaultGranularity 作为默认维度）
  const getPreference = usePreferenceStore((s) => s.getPreference);
  const navDecimals = getPreference('navDecimals');
  const xirrDecimals = getPreference('xirrDecimals');
  const amountThousands = getPreference('amountThousands');
  const amountAbbrev = getPreference('amountAbbrev');
  const [dimension, setDimension] = useState<DimensionSwitcherValue>({
    granularity: getPreference('defaultGranularity') as QueryGranularity,
    startDate,
    endDate,
    // ANL-P0-03：默认聚合读偏好（SET-P0-02 验收4），与 XIRR 页现状一致
    aggregation: getPreference('aggregation') as AggregationMethod,
  });
  const [metric, setMetric] = useState<NavMetric>(NavMetricEnum.BOTH);

  const series = useNavSeries(currentPortfolioId, {
    ...dimension,
    metric,
  });
  const latest = useLatestNav(currentPortfolioId);

  // 热力图 + 每日明细表固定使用日维度数据（独立查询）。
  // 注意：这里是技术必需（每日收益/月度热力图依赖日粒度），不是用户偏好，
  // 因此不读取 defaultGranularity，保持 DAY 硬编码。
  const dayParams: typeof dimension = {
    ...dimension,
    granularity: QueryGranularity.DAY,
  };
  const daySeries = useNavSeries(
    currentPortfolioId,
    dimension.granularity === QueryGranularity.DAY ? { ...dimension, metric } : { ...dayParams, metric },
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
  const dayData = daySeries.data ?? [];

  // 按指标过滤趋势图数据
  const chartData = useMemo(() => {
    if (metric === NavMetricEnum.CUMULATIVE) {
      return seriesData.map((p) => ({ ...p, yearNav: null }));
    }
    if (metric === NavMetricEnum.YEAR) {
      return seriesData.map((p) => ({ ...p, cumulativeNav: null }));
    }
    return seriesData;
  }, [seriesData, metric]);

  const dailyDetails = useMemo(() => computeDailyDetails(dayData), [dayData]);

  const latestCumulativeNav = latest.data?.cumulativeNav ?? null;
  const latestYearNav = latest.data?.yearNav ?? null;
  const totalReturn = latestCumulativeNav !== null ? latestCumulativeNav - 1 : null;
  const yearReturn = latestYearNav !== null ? latestYearNav - 1 : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">净值分析</h1>
        <p className="text-sm text-muted-foreground">
          查看累计净值、当年净值趋势及月度收益分布
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <DimensionSwitcher
          value={dimension}
          onChange={setDimension}
          quickRanges={QUICK_RANGE_OPTIONS}
        />
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">指标</Label>
          <RadioGroup
            value={metric}
            onValueChange={(v) => setMetric(v as NavMetric)}
            orientation="horizontal"
          >
            {METRIC_OPTIONS.map((opt) => (
              <RadioGroupItem key={opt.value} value={opt.value} label={opt.label} />
            ))}
          </RadioGroup>
        </div>
      </div>

      {/* 当前净值摘要（4 卡） */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>当前累计净值</CardDescription>
            <CardTitle className="text-2xl">
              {formatDecimal(latestCumulativeNav, navDecimals)}
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
            <CardDescription>当年净值</CardDescription>
            <CardTitle className="text-2xl">
              {formatDecimal(latestYearNav, navDecimals)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">单位净值口径</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>累计收益</CardDescription>
            <CardTitle className="text-2xl">
              {formatPercent(totalReturn, 2, { decimals: xirrDecimals })}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">自成立以来</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>当年收益</CardDescription>
            <CardTitle className="text-2xl">
              {formatPercent(yearReturn, 2, { decimals: xirrDecimals })}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">今年以来</p>
          </CardContent>
        </Card>
      </div>

      {/* 净值趋势双线图（按指标） */}
      <NavTrendChart
        data={chartData}
        loading={series.isLoading}
        title={
          metric === NavMetricEnum.CUMULATIVE
            ? '净值趋势（累计净值）'
            : metric === NavMetricEnum.YEAR
              ? '净值趋势（当年净值）'
              : '净值趋势（累计 + 当年双线对比）'
        }
      />

      {/* 月度收益热力图 */}
      <MonthlyHeatmap
        data={dayData}
        loading={daySeries.isLoading}
        title="月度收益热力图"
      />

      {/* 每日净值明细表 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">每日净值明细</CardTitle>
          <CardDescription>
            每日收益 =（当日累计净值 − 前日累计净值）× 前日份额；收益百分比 = 每日收益 / 前一日总资产；正红负绿
          </CardDescription>
        </CardHeader>
        <CardContent>
          {daySeries.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : dailyDetails.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              暂无数据
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>日期</TableHead>
                    <TableHead className="text-right">累计净值</TableHead>
                    <TableHead className="text-right">当年净值</TableHead>
                    <TableHead className="text-right">每日收益</TableHead>
                    <TableHead className="text-right">收益百分比</TableHead>
                    <TableHead className="text-right">份额</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dailyDetails.map((row, idx) => (
                    <TableRow key={`${row.date}-${idx}`}>
                      <TableCell className="font-mono text-sm whitespace-nowrap">
                        {row.label}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatDecimal(row.cumulativeNav, navDecimals)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatDecimal(row.yearNav, navDecimals)}
                      </TableCell>
                      <TableCell
                        className={
                          row.dailyReturn !== null && row.dailyReturn >= 0
                            ? 'text-right font-mono text-up'
                            : row.dailyReturn !== null && row.dailyReturn < 0
                              ? 'text-right font-mono text-down'
                              : 'text-right font-mono'
                        }
                      >
                        {row.dailyReturn !== null
                          ? `${row.dailyReturn >= 0 ? '+' : ''}${formatCurrency(row.dailyReturn, 2, { thousands: amountThousands, abbreviate: amountAbbrev })}`
                          : '-'}
                      </TableCell>
                      <TableCell
                        className={
                          row.returnRate !== null && row.returnRate >= 0
                            ? 'text-right font-mono text-up'
                            : row.returnRate !== null && row.returnRate < 0
                              ? 'text-right font-mono text-down'
                              : 'text-right font-mono'
                        }
                      >
                        {formatPercent(row.returnRate, 2, { decimals: xirrDecimals })}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {row.shares !== null
                          ? // ANL-P0-06 验收3：份额显示 6 位小数（Part E-7 跨网约定）
                            Number(row.shares).toLocaleString('zh-CN', {
                              minimumFractionDigits: 6,
                              maximumFractionDigits: 6,
                            })
                          : '-'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {/* 明细表脚注（§7.6 草图口径说明；「前一日」= 前一个记录日，F10） */}
          <p className="mt-3 text-xs text-muted-foreground">
            注：每日收益 =（当日累计净值 − 前日累计净值）× 前日份额；收益百分比 = 每日收益 / 前一日总资产；正红负绿。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
