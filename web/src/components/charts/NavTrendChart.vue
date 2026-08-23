<script setup lang="ts">
/**
 * components/charts/NavTrendChart.vue — 累计净值 + 当年净值双线对比图
 *
 * 平移自 React 版 web/src/components/charts/nav-trend-chart.tsx。
 * option 构造见 ./nav-trend-chart（纯函数，供单测）。
 * 对外契约（props / 默认 title）与 React 版完全一致。
 *
 * BaseChart 内部 notMerge 默认开启：切换 metric 时整体替换 option，
 * 避免「第二次点击显示全部曲线」的旧 series 残留问题。
 */

import { computed } from 'vue';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import BaseChart from '@/components/charts/BaseChart.vue';
import { buildNavTrendOption } from './nav-trend-chart';
import { useChartTheme } from '@/lib/chart-theme';
import { NavMetric } from '@/lib/types';
import type { NavMetric as NavMetricType, NavSeriesPoint } from '@/lib/types';

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
    /** 渲染哪些指标系列（问题④）：'cumulative' / 'year' 只注册所选 series，'both' 双线对比 */
    metric?: NavMetricType;
  }>(),
  { title: '净值趋势', connectNulls: true, metric: NavMetric.BOTH },
);

const chartTheme = useChartTheme();
const option = computed(() =>
  buildNavTrendOption({
    data: props.data,
    connectNulls: props.connectNulls,
    metric: props.metric,
    theme: chartTheme.value,
  }),
);
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
