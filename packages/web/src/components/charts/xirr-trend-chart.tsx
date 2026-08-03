/**
 * components/charts/xirr-trend-chart.tsx — XIRR 趋势折线图（ECharts）
 *
 * 展示累计 XIRR 随时间变化趋势，支持空数据展示。
 * 对外契约（Props / 导出符号 / 默认 title）与迁移前完全一致，调用方无需改动。
 */

import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatPercent } from '@/lib/utils';
import type { XirrSeriesPoint } from '@investment-tracker/shared';

export interface XirrTrendChartProps {
  data: XirrSeriesPoint[];
  loading?: boolean;
  title?: string;
  className?: string;
}

/**
 * 颜色常量。
 * 注意：必须使用「逗号分隔」的 hsl 语法 —— ECharts/zrender 的颜色解析器不支持
 * CSS Color Level 4 的空格语法 `hsl(217 91% 60%)`（静默解析失败返回 null）。
 */
const COLOR_XIRR = 'hsl(217, 91%, 60%)'; // ≈ #3b82f6，与迁移前数值一致
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

export function XirrTrendChart({
  data,
  loading,
  title = 'XIRR 趋势',
  className,
}: XirrTrendChartProps): JSX.Element {
  const option = useMemo(() => {
    // useMemo 无条件先于 JSX 执行，须在此处兜底 undefined/null，
    // 否则下方 `!data ||` 空态分支永不可达，且组件在 data 缺省时抛错。
    const points: XirrSeriesPoint[] = data ?? [];
    const labels: string[] = points.map((d) => d.label);
    const values: (number | null)[] = points.map((d) => d.xirrValue);

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
          const p = arr[0];
          if (!p) return '';
          const v = p.value;
          // null / undefined 必须在调用 formatPercent 前拦截（其空值兜底返回 '-'，非「数据不足」）
          const text = v === null || v === undefined ? '数据不足' : formatPercent(Number(v));
          return `${p.axisValueLabel ?? ''}<br/>${p.marker ?? ''}XIRR: ${text}`;
        },
      },
      grid: { left: 8, right: 20, top: 10, bottom: 5, containLabel: true },
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
          formatter: (v: number): string => `${(v * 100).toFixed(0)}%`,
        },
        splitLine: { show: true, lineStyle: { type: [3, 3], color: GRID_COLOR } },
      },
      series: [
        {
          name: 'XIRR',
          type: 'line',
          smooth: true,
          connectNulls: true,
          showSymbol: false,
          symbolSize: 8, // 直径 8 = 半径 4，对应迁移前 activeDot={{ r: 4 }}
          emphasis: { scale: false }, // 关闭 hover 额外放大，锁死 r=4
          lineStyle: { width: 2, color: COLOR_XIRR },
          itemStyle: { color: COLOR_XIRR },
          data: values,
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
