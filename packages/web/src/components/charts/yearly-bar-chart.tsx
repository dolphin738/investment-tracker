/**
 * components/charts/yearly-bar-chart.tsx — 年度收益柱状图（ECharts）
 *
 * 输入 XirrSeriesPoint[]（按年聚合），展示各年度收益率对比柱状图。
 * 对外契约（Props / 导出符号 / 默认 title）与迁移前完全一致，调用方无需改动。
 */

import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatPercent } from '@/lib/utils';
import type { XirrSeriesPoint } from '@investment-tracker/shared';

export interface YearlyBarChartProps {
  data: XirrSeriesPoint[];
  loading?: boolean;
  title?: string;
  className?: string;
}

/**
 * 颜色常量。
 * 注意：必须使用「逗号分隔」的 hsl 语法 —— ECharts/zrender 的颜色解析器不支持
 * CSS Color Level 4 的空格语法 `hsl(142 71% 45%)`（静默解析失败返回 null）。
 */
const POSITIVE_COLOR = 'hsl(142, 71%, 45%)'; // ≈ #22c55e，与迁移前数值一致
const NEGATIVE_COLOR = 'hsl(0, 84%, 60%)'; // ≈ #ef4444，与迁移前数值一致
/** 空值柱颜色：ECharts canvas 不解析 CSS 变量，故用硬编码值替代原 hsl(var(--muted-foreground)) */
const MUTED_COLOR = '#94a3b8';
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

/** ECharts itemStyle 颜色回调入参（仅声明本组件用到的字段） */
interface ItemStyleParam {
  dataIndex: number;
}

export function YearlyBarChart({
  data,
  loading,
  title = '年度 XIRR 对比',
  className,
}: YearlyBarChartProps): JSX.Element {
  const option = useMemo(() => {
    const labels: string[] = data.map((d) => d.label);
    const values: (number | null)[] = data.map((d) => d.xirrValue);

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
        boundaryGap: true,
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
          type: 'bar',
          data: values,
          itemStyle: {
            borderRadius: [4, 4, 0, 0],
            // 逐柱着色：等价于迁移前的 <Cell fill={...} />
            color: (params: ItemStyleParam): string => {
              const v = data[params.dataIndex]?.xirrValue;
              // 该分支不可见（null 不绘制柱形），保留仅为语义完整
              if (v === null || v === undefined) return MUTED_COLOR;
              return v >= 0 ? POSITIVE_COLOR : NEGATIVE_COLOR;
            },
          },
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
