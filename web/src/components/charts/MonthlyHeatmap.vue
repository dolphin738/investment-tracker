<script setup lang="ts">
/**
 * components/charts/MonthlyHeatmap.vue — 月度收益热力图
 *
 * 平移自 React 版 web/src/components/charts/monthly-heatmap.tsx。
 * 月度收益计算与 option 构造见 ./monthly-heatmap（纯函数，供单测）。
 */

import { computed } from 'vue';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import BaseChart from '@/components/charts/BaseChart.vue';
import { buildMonthlyHeatmapOption, computeMonthlyReturns } from './monthly-heatmap';
import { useChartTheme } from '@/lib/chart-theme';
import type { NavSeriesPoint } from '@/lib/types';

const props = withDefaults(
  defineProps<{
    /** 日维度的净值序列（用于计算月度收益） */
    data: NavSeriesPoint[];
    loading?: boolean;
    title?: string;
    class?: string;
  }>(),
  { title: '月度收益热力图' },
);

const monthly = computed(() => computeMonthlyReturns(props.data ?? []));

const chartTheme = useChartTheme();
const option = computed(() =>
  buildMonthlyHeatmapOption({ ...monthly.value, theme: chartTheme.value }),
);
</script>

<template>
  <Card :class="props.class">
    <CardHeader>
      <CardTitle class="text-base">{{ props.title }}</CardTitle>
    </CardHeader>
    <CardContent>
      <Skeleton v-if="props.loading" class="h-[320px] w-full" />
      <div
        v-else-if="monthly.cells.length === 0"
        class="flex h-[320px] items-center justify-center text-sm text-muted-foreground"
      >
        暂无数据
      </div>
      <BaseChart v-else :option="option" :height="320" />
    </CardContent>
  </Card>
</template>
