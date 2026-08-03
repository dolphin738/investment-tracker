/**
 * components/charts/nav-trend-chart.tsx — 累计净值 + 当年净值双线对比图（ECharts）
 *
 * 对外契约（Props / 导出符号 / 默认 title）与迁移前完全一致，调用方无需改动。
 */

import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDecimal } from '@/lib/utils';
import type { NavSeriesPoint } from '@investment-tracker/shared';

export interface NavTrendChartProps {
  data: NavSeriesPoint[];
  loading?: boolean;
  title?: string;
  className?: string;
}

/**
 * 颜色常量。
 * 注意：必须使用「逗号分隔」的 hsl 语法 —— ECharts/zrender 的颜色解析器不支持
 * CSS Color Level 4 的空格语法 `hsl(217 91% 60%)`（静默解析失败返回 null）。
 */
const COLOR_CUMULATIVE = 'hsl(217, 91%, 60%)'; // ≈ #3b82f6，与迁移前数值一致
const COLOR_YEAR = 'hsl(142, 71%, 45%)'; // ≈ #22c55e，与迁移前数值一致
/** 网格线色：与迁移前实际渲染色一致（class 未生效，实渲染为 #ccc） */
const GRID_COLOR = '#ccc';
/** 轴标签色：与迁移前实际渲染色一致（tick 自带 fill="#666"） */
const AXIS_COLOR = '#666';

/** ECharts `trigger: 'axis'` tooltip 回调入参（仅声明本组件用到的字段） */
interface AxisTooltipParam {
  axisValueLabel?: string;
  seriesName?: string;
  marker?: string;
  value?: number | string | null;
  dataIndex: number;
}

export function NavTrendChart({
  data,
  loading,
  title = '净值趋势',
  className,
}: NavTrendChartProps): JSX.Element {
  const option = useMemo(() => {
    const labels: string[] = data.map((d) => d.label);
    const cumulativeSeries: (number | null)[] = data.map((d) => d.cumulativeNav);
    const yearSeries: (number | null)[] = data.map((d) => d.yearNav);

    return {
      tooltip: {
        trigger: 'axis',
        // 背景/边框交给 extraCssText（tooltip 为 DOM，CSS 变量由浏览器解析，可跟随主题）
        backgroundColor: 'transparent',
        borderWidth: 0,
        padding: 0,
        textStyle: { fontSize: 12 },
        extraCssText:
          'background: hsl(var(--popover));' +
          'border: 1px solid hsl(var(--border));' +
          'border-radius: 6px;' +
          'color: hsl(var(--popover-foreground));' +
          'padding: 8px 12px;' +
          'box-shadow: none;',
        formatter: (params: AxisTooltipParam | AxisTooltipParam[]): string => {
          const arr: AxisTooltipParam[] = Array.isArray(params) ? params : [params];
          const head: string = arr[0]?.axisValueLabel ?? '';
          const lines: string[] = arr.map((p) => {
            const v = p.value;
            // null / undefined 必须在调用 formatDecimal 前拦截（其空值兜底返回 '-'，非「数据不足」）
            const text =
              v === null || v === undefined ? '数据不足' : formatDecimal(Number(v), 4);
            return `${p.marker ?? ''}${p.seriesName ?? ''}: ${text}`;
          });
          return [head, ...lines].join('<br/>');
        },
      },
      legend: {
        bottom: 0,
        textStyle: { fontSize: 12 },
      },
      grid: { left: 8, right: 20, top: 10, bottom: 28, containLabel: true },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: labels,
        axisLabel: { fontSize: 12, color: AXIS_COLOR },
        // ECharts category 轴默认无 splitLine，需显式开启才等价于迁移前的双向网格
        splitLine: { show: true, lineStyle: { type: [3, 3], color: GRID_COLOR } },
      },
      yAxis: {
        type: 'value',
        axisLabel: {
          fontSize: 12,
          color: AXIS_COLOR,
          formatter: (v: number): string => v.toFixed(2),
        },
        splitLine: { show: true, lineStyle: { type: [3, 3], color: GRID_COLOR } },
      },
      series: [
        {
          name: '累计净值',
          type: 'line',
          smooth: true,
          connectNulls: true,
          showSymbol: false,
          symbolSize: 8, // 直径 8 = 半径 4，对应迁移前 activeDot={{ r: 4 }}
          emphasis: { scale: false }, // 关闭 hover 额外放大，锁死 r=4
          lineStyle: { width: 2, color: COLOR_CUMULATIVE },
          itemStyle: { color: COLOR_CUMULATIVE },
          data: cumulativeSeries,
        },
        {
          name: '当年净值',
          type: 'line',
          smooth: true,
          connectNulls: true,
          showSymbol: false,
          symbolSize: 8,
          emphasis: { scale: false },
          lineStyle: { width: 2, color: COLOR_YEAR },
          itemStyle: { color: COLOR_YEAR },
          data: yearSeries,
        },
      ],
    };
  }, [data]);

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-[260px] w-full" />
        ) : !data || data.length === 0 ? (
          <EmptyState />
        ) : (
          <ReactECharts option={option} style={{ height: 260, width: '100%' }} />
        )}
      </CardContent>
    </Card>
  );
}

function EmptyState(): JSX.Element {
  return (
    <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
      暂无数据
    </div>
  );
}
