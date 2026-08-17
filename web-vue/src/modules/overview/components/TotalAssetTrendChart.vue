<script setup lang="ts">
/**
 * modules/overview/components/TotalAssetTrendChart.vue — 总资产走势图（含手工记录标记）
 *
 * 平移自 React 版 web/src/features/overview/total-asset-trend-chart.tsx 的渲染部分
 * （纯函数已拆至 features/total-asset-trend-chart.ts 便于单测）。
 *
 * 【数据获取分工（混合式，设计 §4.2）】
 * - 净值序列 data 由页面传入 —— 概览页已为「净值趋势」调用 useNavSeries，
 *   复用同一份数据，零额外请求，且两张图的点严格同源。
 * - 手工记录标记由组件内 useSnapshots 自取 —— 只有本图需要，内聚在此。
 *   走服务端 source=MANUAL 筛选。
 *
 * 图表高度 300px（概览页 hero 图，比四宫格的 260px 更高，确立主次层次）。
 */

import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { ChevronRight } from 'lucide-vue-next';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import BaseChart from '@/components/charts/BaseChart.vue';
import { chartGrid } from '@/components/charts/chart-grid';
import type { EChartsOption } from 'echarts';
import { useSnapshots } from '../composables/use-snapshots';
import { ROUTE_PATH } from '@/lib/constants';
import { formatCurrency } from '@/lib/utils';
import { SnapshotSource } from '@/lib/types';
import type { NavSeriesPoint } from '@/lib/types';
import {
  MANUAL_MARK_PAGE_SIZE,
  buildManualScatter,
  buildTrendPoints,
  collectManualDates,
  formatAxisTooltip,
} from '../features/total-asset-trend-chart';

const props = withDefaults(
  defineProps<{
    /** 净值序列（由页面传入，与「净值趋势」共用同一份数据） */
    data: NavSeriesPoint[];
    /** 序列加载中 */
    loading?: boolean;
    /** 当前组合 ID —— 组件内自取手工记录标记所需的快照 */
    portfolioId: string | null;
    /** 图表区间起（仅用于查询手工记录快照，与 data 的区间保持一致） */
    startDate: string;
    /** 图表区间止 */
    endDate: string;
    /** 金额千分位偏好 */
    amountThousands?: boolean;
    /** 金额缩写偏好 */
    amountAbbrev?: boolean;
    title?: string;
    class?: string;
  }>(),
  {
    loading: false,
    amountThousands: undefined,
    amountAbbrev: undefined,
    title: '总资产走势',
  },
);

/** 主线色（与「净值趋势」累计线同色系） */
const COLOR_LINE = 'hsl(217, 91%, 60%)';
/** 手工记录散点色 */
const COLOR_MANUAL = 'hsl(0, 84%, 48%)';
/** 网格线 / 轴标签色（与其它图表一致） */
const GRID_COLOR = '#ccc';
const AXIS_COLOR = '#666';

const trendPoints = computed(() => buildTrendPoints(props.data));

/**
 * 手工记录快照（服务端 source=MANUAL 筛选）。
 *
 * 无走势点时传 null 关闭查询：此时图表进空态、标记无处可落，
 * 发这个请求纯属浪费（也让首屏/空组合少一次网络往返）。
 */
const manualSnapshots = useSnapshots(
  computed(() => (trendPoints.value.length > 0 ? props.portfolioId : null)),
  {
    startDate: props.startDate,
    endDate: props.endDate,
    page: 1,
    pageSize: MANUAL_MARK_PAGE_SIZE,
    source: SnapshotSource.MANUAL,
  },
);

const manualDates = computed(() =>
  collectManualDates(manualSnapshots.data.value?.items),
);

/** 手工记录数超出单页上限 → 给灰字提示，不阻塞主线 */
const manualTruncated = computed(
  () => (manualSnapshots.data.value?.total ?? 0) > MANUAL_MARK_PAGE_SIZE,
);

const option = computed((): EChartsOption => {
  const labels = trendPoints.value.map((p) => p.label);
  const values = trendPoints.value.map((p) => p.totalAsset);
  const manualPoints = buildManualScatter(trendPoints.value, manualDates.value);
  const money = (v: number): string =>
    formatCurrency(v, 2, {
      thousands: props.amountThousands,
      abbreviate: props.amountAbbrev,
    });

  return {
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown): string =>
        formatAxisTooltip(
          params as Parameters<typeof formatAxisTooltip>[0],
          money,
        ),
    },
    legend: { bottom: 0, textStyle: { fontSize: 12 } },
    // 右侧留白由 chart-grid 统一给足，避免末位日期被裁切
    grid: chartGrid(),
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: labels,
      axisLabel: { fontSize: 11, color: AXIS_COLOR },
    },
    yAxis: {
      type: 'value',
      axisLabel: {
        fontSize: 11,
        color: AXIS_COLOR,
        formatter: (v: number): string => `${(v / 10000).toFixed(1)}万`,
      },
      splitLine: { show: true, lineStyle: { type: [3, 3], color: GRID_COLOR } },
    },
    series: [
      {
        name: '总资产',
        type: 'line',
        smooth: true,
        connectNulls: true,
        showSymbol: false,
        lineStyle: { width: 2, color: COLOR_LINE },
        itemStyle: { color: COLOR_LINE },
        data: values,
      },
      {
        name: '手工记录',
        type: 'scatter',
        symbolSize: 8,
        itemStyle: { color: COLOR_MANUAL },
        data: manualPoints,
        tooltip: {
          formatter: (p: { value?: unknown }): string => {
            const v = Array.isArray(p.value) ? p.value[1] : p.value;
            return `手工记录：${money(Number(v))}`;
          },
        },
      },
    ],
  };
});
</script>

<template>
  <Card :class="props.class">
    <CardHeader class="flex flex-row items-center justify-between space-y-0">
      <CardTitle class="text-base">{{ props.title }}</CardTitle>
      <!-- 单一 /snapshots 入口（查看全部历史） -->
      <div class="flex items-center gap-3 text-xs">
        <RouterLink
          :to="ROUTE_PATH.SNAPSHOTS"
          class="flex items-center text-muted-foreground hover:underline"
        >
          查看全部历史
          <ChevronRight class="h-3.5 w-3.5" />
        </RouterLink>
      </div>
    </CardHeader>
    <CardContent class="space-y-2">
      <!-- 高度类必须是字面量 —— Tailwind 静态扫描不认模板串拼接的任意值类 -->
      <Skeleton v-if="props.loading" class="h-[300px] w-full" />
      <div
        v-else-if="trendPoints.length === 0"
        class="flex h-[300px] items-center justify-center text-sm text-muted-foreground"
      >
        当前范围暂无资产数据
      </div>
      <template v-else>
        <BaseChart :option="option" :height="300" />
        <p
          v-if="manualTruncated"
          class="text-right text-xs text-muted-foreground"
        >
          仅显示前 {{ MANUAL_MARK_PAGE_SIZE }} 个手工记录标记
        </p>
      </template>
    </CardContent>
  </Card>
</template>
