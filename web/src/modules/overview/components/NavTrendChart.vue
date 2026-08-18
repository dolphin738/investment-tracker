<script setup lang="ts">
/**
 * modules/overview/components/NavTrendChart.vue — 累计净值 + 当年净值双线对比图
 *
 * 平移自 React 版 web/src/components/charts/nav-trend-chart.tsx。
 * 对外契约（Props / 默认 title）与 React 版一致；ECharts 经 BaseChart 挂载
 * （notMerge 默认开启，切换 metric 时整体替换 option，旧 series 不残留）。
 */

import { computed } from 'vue';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import BaseChart from '@/components/charts/BaseChart.vue';
import { chartGrid } from '@/components/charts/chart-grid';
import type { EChartsOption } from 'echarts';
import { formatDecimal } from '@/lib/utils';
import { NavMetric } from '@/lib/types';
import type { NavSeriesPoint } from '@/lib/types';

const props = withDefaults(
  defineProps<{
    data: NavSeriesPoint[];
    loading?: boolean;
    title?: string;
    class?: string;
    /**
     * null 数据点是否连线。
     * 默认 true（历史行为，保持测试契约）；PRD §7.5 要求断线时传 false。
     */
    connectNulls?: boolean;
    /**
     * 渲染哪些指标系列：
     * - 'cumulative' / 'year'：只注册所选的那一条 series
     * - 'both'（缺省）：双线对比，保持历史行为
     */
    metric?: NavMetric;
  }>(),
  {
    loading: false,
    title: '净值趋势',
    connectNulls: true,
    metric: NavMetric.BOTH,
  },
);

/**
 * 颜色常量。
 * 注意：必须使用「逗号分隔」的 hsl 语法 —— ECharts/zrender 的颜色解析器不支持
 * CSS Color Level 4 的空格语法 `hsl(217 91% 60%)`（静默解析失败返回 null）。
 */
const COLOR_CUMULATIVE = 'hsl(217, 91%, 60%)';
const COLOR_YEAR = 'hsl(142, 71%, 45%)';
/** 网格线色：与迁移前实际渲染色一致 */
const GRID_COLOR = '#ccc';
/** 轴标签色：与迁移前实际渲染色一致 */
const AXIS_COLOR = '#666';

// 返回值注解 EChartsOption 提供上下文类型：字面量 type/trigger 等按目标类型收窄
// （等价 React 版 useMemo<EChartsOption> 的类型契约）
const option = computed((): EChartsOption => {
  const points: NavSeriesPoint[] = props.data ?? [];
  const labels: string[] = points.map((d) => d.label);
  const cumulativeSeries: (number | null)[] = points.map((d) => d.cumulativeNav);
  const yearSeries: (number | null)[] = points.map((d) => d.yearNav);
  const connect = props.connectNulls;

  // 问题④：只注册所选指标的 series，未选中的整条不进 option
  const showCumulative =
    props.metric === NavMetric.CUMULATIVE || props.metric === NavMetric.BOTH;
  const showYear =
    props.metric === NavMetric.YEAR || props.metric === NavMetric.BOTH;

  // as const 收窄 type 字面量：series 元素经展开进入 EChartsOption.series 联合
  const cumulativeSeriesOption = {
    name: '累计净值',
    type: 'line' as const,
    smooth: true,
    connectNulls: connect,
    showSymbol: false,
    symbolSize: 8,
    emphasis: { scale: false },
    lineStyle: { width: 2, color: COLOR_CUMULATIVE },
    itemStyle: { color: COLOR_CUMULATIVE },
    data: cumulativeSeries,
  };

  const yearSeriesOption = {
    name: '当年净值',
    type: 'line' as const,
    smooth: true,
    connectNulls: connect,
    showSymbol: false,
    symbolSize: 8,
    emphasis: { scale: false },
    lineStyle: { width: 2, color: COLOR_YEAR },
    itemStyle: { color: COLOR_YEAR },
    data: yearSeries,
  };

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
      formatter: (params: unknown): string => {
        const arr = Array.isArray(params) ? params : [params];
        const rows = arr as Array<{
          axisValueLabel?: string;
          seriesName?: string;
          marker?: string;
          value?: number | string | null;
        }>;
        const head: string = rows[0]?.axisValueLabel ?? '';
        const lines: string[] = rows.map((p) => {
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
    // 右侧留白由 chart-grid 统一给足，避免末位日期被裁切
    grid: chartGrid(),
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: labels,
      // 强制显示首/尾日期标签，并隐藏重叠标签
      axisLabel: {
        fontSize: 12,
        color: AXIS_COLOR,
        showMinLabel: true,
        showMaxLabel: true,
        hideOverlap: true,
      },
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
      ...(showCumulative ? [cumulativeSeriesOption] : []),
      ...(showYear ? [yearSeriesOption] : []),
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
