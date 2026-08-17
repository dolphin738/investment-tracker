<script setup lang="ts">
/**
 * modules/overview/components/XirrTrendChart.vue — XIRR 趋势折线图
 *
 * 平移自 React 版 web/src/components/charts/xirr-trend-chart.tsx。
 * 对外契约（Props / 默认 title）与 React 版一致；ECharts 经 BaseChart 挂载。
 */

import { computed } from 'vue';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import BaseChart from '@/components/charts/BaseChart.vue';
import { chartGrid } from '@/components/charts/chart-grid';
import type { EChartsOption } from 'echarts';
import { formatPercent } from '@/lib/utils';
import type { XirrSeriesPoint } from '@/lib/types';

const props = withDefaults(
  defineProps<{
    data: XirrSeriesPoint[];
    loading?: boolean;
    title?: string;
    class?: string;
    /**
     * null 数据点是否连线。
     * 默认 true（历史行为）；PRD §7.5 要求「null 断线不画 0」时传 false。
     */
    connectNulls?: boolean;
  }>(),
  {
    loading: false,
    title: 'XIRR 趋势',
    connectNulls: true,
  },
);

/**
 * 颜色常量。
 * 注意：必须使用「逗号分隔」的 hsl 语法 —— ECharts/zrender 的颜色解析器不支持
 * CSS Color Level 4 的空格语法 `hsl(217 91% 60%)`（静默解析失败返回 null）。
 */
const COLOR_XIRR = 'hsl(217, 91%, 60%)';
/** 网格线色：与迁移前实际渲染色一致 */
const GRID_COLOR = '#ccc';
/** 轴标签色：与迁移前实际渲染色一致 */
const AXIS_COLOR = '#666';

const option = computed((): EChartsOption => {
  const points: XirrSeriesPoint[] = props.data ?? [];
  const labels: string[] = points.map((d) => d.label);
  const values: (number | null)[] = points.map((d) => d.xirrValue);
  const connect = props.connectNulls;

  return {
    tooltip: {
      trigger: 'axis',
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
      formatter: (params: unknown): string => {
        const arr = Array.isArray(params) ? params : [params];
        const p = (arr as Array<{
          axisValueLabel?: string;
          marker?: string;
          value?: number | string | null;
        }>)[0];
        if (!p) return '';
        const v = p.value;
        // null / undefined 必须在调用 formatPercent 前拦截（其空值兜底返回 '-'，非「数据不足」）
        const text =
          v === null || v === undefined ? '数据不足' : formatPercent(Number(v));
        return `${p.axisValueLabel ?? ''}<br/>${p.marker ?? ''}XIRR: ${text}`;
      },
    },
    // 右侧留白由 chart-grid 统一给足，避免末位日期被裁切
    grid: chartGrid({ bottom: 5 }),
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: labels,
      axisLabel: { fontSize: 12, color: AXIS_COLOR },
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
        connectNulls: connect,
        showSymbol: false,
        symbolSize: 8,
        emphasis: { scale: false },
        lineStyle: { width: 2, color: COLOR_XIRR },
        itemStyle: { color: COLOR_XIRR },
        data: values,
      },
    ],
  };
});
</script>

<template>
  <Card :class="props.class">
    <CardHeader>
      <CardTitle class="text-base">{{ props.title }}</CardTitle>
    </CardHeader>
    <CardContent>
      <Skeleton v-if="props.loading" class="h-[260px] w-full" />
      <div
        v-else-if="!props.data || props.data.length === 0"
        class="flex h-[260px] items-center justify-center text-sm text-muted-foreground"
      >
        暂无数据
      </div>
      <BaseChart v-else :option="option" :height="260" />
    </CardContent>
  </Card>
</template>
