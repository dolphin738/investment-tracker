/**
 * components/charts/monthly-heatmap.tsx — 月度收益热力图（ECharts）
 *
 * 横轴 1-12 月，纵轴年份，颜色映射月度收益率。
 * 数据来源：日维度 NavSeriesPoint，按 (年, 月) 聚合计算月度收益率 = 月末当年净值 - 上月末当年净值。
 */

import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { NavSeriesPoint } from '@investment-tracker/shared';

export interface MonthlyHeatmapProps {
  /** 日维度的净值序列（用于计算月度收益） */
  data: NavSeriesPoint[];
  loading?: boolean;
  title?: string;
  className?: string;
}

interface HeatCell {
  year: number;
  month: number;
  rate: number | null;
}

/** 从日维度净值序列计算月度收益率 */
function computeMonthlyReturns(data: NavSeriesPoint[]): {
  years: number[];
  months: number[];
  cells: HeatCell[];
} {
  if (!data || data.length === 0) {
    return { years: [], months: [], cells: [] };
  }
  // 按日期排序
  const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date));

  // 按 (year, month) 分组，取该月最后一条记录的 yearNav
  const monthlyMap = new Map<string, { year: number; month: number; yearNav: number | null }>();
  for (const point of sorted) {
    const d = new Date(point.date);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    monthlyMap.set(`${year}-${month}`, { year, month, yearNav: point.yearNav });
  }

  const yearsSet = new Set<number>();
  const monthSet = new Set<number>();
  const cells: HeatCell[] = [];

  // 按 (year, month) 顺序计算环比
  const sortedKeys = Array.from(monthlyMap.keys()).sort();
  let prev: { year: number; month: number; yearNav: number | null } | null = null;
  for (const key of sortedKeys) {
    const cur = monthlyMap.get(key)!;
    yearsSet.add(cur.year);
    monthSet.add(cur.month);
    if (prev && cur.yearNav !== null && prev.yearNav !== null && prev.yearNav !== 0) {
      const rate = cur.yearNav - prev.yearNav;
      cells.push({ year: cur.year, month: cur.month, rate });
    } else {
      cells.push({ year: cur.year, month: cur.month, rate: null });
    }
    prev = cur;
  }

  const years = Array.from(yearsSet).sort((a, b) => a - b);
  const months = Array.from(monthSet).sort((a, b) => a - b);
  return { years, months, cells };
}

export function MonthlyHeatmap({
  data,
  loading,
  title = '月度收益热力图',
  className,
}: MonthlyHeatmapProps): JSX.Element {
  const { years, months, cells } = useMemo(() => computeMonthlyReturns(data), [data]);

  const option = useMemo(() => {
    const monthLabels = months.map((m) => `${m}月`);
    const yearLabels = years.map((y) => y.toString());
    const seriesData: [number, number, number | string][] = [];
    let maxAbs = 0;
    cells.forEach((cell) => {
      const x = months.indexOf(cell.month);
      const y = years.indexOf(cell.year);
      if (x >= 0 && y >= 0) {
        if (cell.rate !== null) {
          maxAbs = Math.max(maxAbs, Math.abs(cell.rate));
          seriesData.push([x, y, cell.rate]);
        } else {
          seriesData.push([x, y, '-']);
        }
      }
    });

    return {
      tooltip: {
        position: 'top',
        formatter: (params: { value: [number, number, number | string] }) => {
          const [x, y, v] = params.value;
          const year = years[y];
          const month = months[x];
          if (v === '-' || v === null || typeof v !== 'number') {
            return `${year}年 ${month}月: 数据不足`;
          }
          return `${year}年 ${month}月: ${(v * 100).toFixed(2)}%`;
        },
      },
      grid: { top: 30, right: 30, bottom: 40, left: 60 },
      xAxis: {
        type: 'category',
        data: monthLabels,
        splitArea: { show: true },
        axisLabel: { fontSize: 11 },
      },
      yAxis: {
        type: 'category',
        data: yearLabels,
        splitArea: { show: true },
        axisLabel: { fontSize: 11 },
      },
      visualMap: {
        min: -maxAbs || -0.1,
        max: maxAbs || 0.1,
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        textStyle: { fontSize: 11 },
        inRange: {
          // PRD §9.5: 正红负绿 — min(最负) → 绿色, max(最正) → 红色
          color: ['#15803d', '#22c55e', '#86efac', '#fde68a', '#fca5a5', '#f87171', '#ef4444'],
        },
      },
      series: [
        {
          type: 'heatmap',
          data: seriesData,
          label: { show: false },
          emphasis: {
            itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0, 0, 0, 0.5)' },
          },
        },
      ],
    };
  }, [years, months, cells]);

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-[320px] w-full" />
        ) : cells.length === 0 ? (
          <div className="flex h-[320px] items-center justify-center text-sm text-muted-foreground">
            暂无数据
          </div>
        ) : (
          <ReactECharts option={option} style={{ height: 320, width: '100%' }} />
        )}
      </CardContent>
    </Card>
  );
}
