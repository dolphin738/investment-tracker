<script setup lang="ts">
/**
 * components/charts/YearlyBarChart.vue — 年度收益柱状图
 *
 * 平移自 React 版 web/src/components/charts/yearly-bar-chart.tsx。
 * option 构造见 ./yearly-bar-chart（纯函数，供单测）。
 * 对外契约（props / 默认 title）与 React 版完全一致。
 */

import { computed } from 'vue';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import BaseChart from '@/components/charts/BaseChart.vue';
import { buildYearlyBarOption } from './yearly-bar-chart';
import { useChartTheme } from '@/lib/chart-theme';
import type { XirrSeriesPoint } from '@/lib/types';

const props = withDefaults(
  defineProps<{
    data: XirrSeriesPoint[];
    loading?: boolean;
    title?: string;
    class?: string;
    /** DASH-P1-05 验收 2：高亮当年柱（加深填充色形成视觉强调） */
    highlightCurrentYear?: boolean;
    /** 高亮目标年份（默认系统当前年） */
    currentYear?: number;
  }>(),
  { title: '年度 XIRR 对比', highlightCurrentYear: false },
);

const chartTheme = useChartTheme();
const option = computed(() =>
  buildYearlyBarOption({
    data: props.data,
    highlightCurrentYear: props.highlightCurrentYear,
    currentYear: props.currentYear,
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
