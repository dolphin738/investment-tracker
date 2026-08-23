<script setup lang="ts">
/**
 * components/charts/XirrTrendChart.vue — XIRR 趋势折线图
 *
 * 平移自 React 版 web/src/components/charts/xirr-trend-chart.tsx。
 * option 构造见 ./xirr-trend-chart（纯函数，供单测）。
 * 对外契约（props / 默认 title）与 React 版完全一致。
 */

import { computed } from 'vue';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import BaseChart from '@/components/charts/BaseChart.vue';
import { buildXirrTrendOption } from './xirr-trend-chart';
import { useChartTheme } from '@/lib/chart-theme';
import type { XirrSeriesPoint } from '@/lib/types';

const props = withDefaults(
  defineProps<{
    data: XirrSeriesPoint[];
    loading?: boolean;
    title?: string;
    class?: string;
    /**
     * null 数据点是否连线。
     * 默认 true（历史行为，保持测试契约）；
     * PRD §7.5 要求「null 断线不画 0」时传 false。
     */
    connectNulls?: boolean;
  }>(),
  { title: 'XIRR 趋势', connectNulls: true },
);

const chartTheme = useChartTheme();
const option = computed(() =>
  buildXirrTrendOption({
    data: props.data,
    connectNulls: props.connectNulls,
    theme: chartTheme.value,
  }),
);

/** P3-1：读屏数据摘要（sr-only），用首末有效 XIRR 点 */
const chartSummary = computed(() => {
  const valid = props.data.filter((d) => d.xirrValue !== null && d.xirrValue !== undefined);
  if (valid.length === 0) return `${props.title}：暂无数据`;
  const first = valid[0];
  const last = valid[valid.length - 1];
  const fmt = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;
  return `${props.title}：自 ${first.date} 的 ${fmt(first.xirrValue as number)} 至 ${last.date} 的 ${fmt(last.xirrValue as number)}`;
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
      <BaseChart
        v-else
        :option="option"
        :height="260"
        :aria-label="props.title"
        :summary="chartSummary"
      />
    </CardContent>
  </Card>
</template>
