<script setup lang="ts">
/**
 * modules/analysis/pages/XirrAnalysisPage.vue — 收益分析页（PRD §7.5）
 *
 * 平移自 React 版 web/src/pages/xirr-analysis.tsx，行为契约一致：
 * - 维度切换 [日][周][月][年] + 范围
 * - 当前累计 XIRR + 较年初
 * - XIRR 趋势折线图（null 断线不画 0 → connectNulls=false）
 * - 年度 XIRR 柱状图
 * - 明细表（日期/XIRR/环比变化）
 */

import { computed, ref } from 'vue';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import DimensionSwitcher from '../components/DimensionSwitcher.vue';
import { toDimensionQueryParams, type DimensionSwitcherValue } from '../features/dimension';
import { QUICK_RANGE_OPTIONS, resolveQuickRange } from '@/modules/query/quick-range';
import { useDefaultDateRange } from '@/modules/query/use-default-date-range';
import { useRangePreferenceSync } from '../composables/use-range-preference-sync';
import {
  useLatestXirr,
  useXirrSeries,
  useYearStartXirr,
} from '../composables/use-query-data';
import XirrTrendChart from '@/components/charts/XirrTrendChart.vue';
import YearlyBarChart from '@/components/charts/YearlyBarChart.vue';
import PageHeader from '@/components/common/PageHeader.vue';
import MetricCard from '@/components/common/MetricCard.vue';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { usePreferenceStore } from '@/stores/preference.store';
import { formatChange, formatPercent, formatDate } from '@/lib/utils';
import {
  AggregationMethod,
  QueryGranularity,
  type XirrSeriesPoint,
} from '@/lib/types';

const portfolioStore = usePortfolioStore();
// 「全部」快捷项的起点 = 组合首个交易日（问题②）
const currentPortfolioId = computed(() => portfolioStore.currentPortfolioId);
const baseDate = computed(() => portfolioStore.currentPortfolioBaseDate);

const preferenceStore = usePreferenceStore();

// I-04：默认日期范围 = 偏好（URL 无 range 参数时），非法/空回落 '1y'
const defaultRange = useDefaultDateRange();
// 维度初始值（SET-P0-02 验收 4：读取偏好 defaultGranularity 作为默认维度）
const xirrDecimals = preferenceStore.getPreference('xirrDecimals');

const initialRange = resolveQuickRange(defaultRange.value, {
  allRangeStart: baseDate.value ?? undefined,
});

// 与 React useState 一致：初始值一次性定格，偏好到达后的纠正交给对齐守卫
const dimension = ref<DimensionSwitcherValue>({
  granularity: preferenceStore.getPreference('defaultGranularity') as QueryGranularity,
  startDate: initialRange.startDate,
  endDate: initialRange.endDate,
  aggregation: AggregationMethod.LAST,
  // INC-01：快捷范围受控回显，首帧取偏好回落值（'1y'），偏好到达后由对齐 watch 纠正
  quick: defaultRange.value,
});

/**
 * 偏好对齐守卫（INC-01 决策 E · 统一范式）。
 *
 * 取代原先「每次 defaultRange/baseDate 变化就无条件覆盖 dimension」的写法 ——
 * 那会在用户手动改过范围后把选择弹回偏好默认值（持仓页曾踩过的 QA Bug）。
 */
const { markInteracted } = useRangePreferenceSync({
  currentQuick: () => dimension.value.quick ?? '',
  currentStartDate: () => dimension.value.startDate,
  allRangeStart: baseDate,
  urlParamKeys: ['range', 'startDate', 'endDate'],
  onAlign: (alignment) => {
    dimension.value = {
      ...dimension.value,
      quick: alignment.quick,
      startDate: alignment.startDate,
      endDate: alignment.endDate,
    };
  },
});

/** 维度/范围变更入口：改动了日期范围即标记用户交互（此后不再被偏好对齐覆盖） */
function handleDimensionChange(next: DimensionSwitcherValue): void {
  if (
    next.quick !== dimension.value.quick ||
    next.startDate !== dimension.value.startDate ||
    next.endDate !== dimension.value.endDate
  ) {
    markInteracted();
  }
  dimension.value = next;
}

// 必须剥离 quick（纯 UI 回显字段）：后端 ValidationPipe forbidNonWhitelisted 会 400
const seriesParams = computed(() => toDimensionQueryParams(dimension.value));
const series = useXirrSeries(currentPortfolioId, seriesParams);
const latest = useLatestXirr(currentPortfolioId);
// 较年初基准：独立日粒度查询当年首个非空 XIRR（ANL-P0-04 / Part E-6），
// 与页面维度/范围解耦 —— 修复旧实现「查询范围不含年初时基准错」的缺陷（Part A2）
const yearStartQuery = useYearStartXirr(currentPortfolioId);

const seriesData = computed<XirrSeriesPoint[]>(() => series.data.value ?? []);
const currentValue = computed(() => latest.data.value?.xirrValue ?? null);

const yearStartValue = computed(() => yearStartQuery.data.value ?? null);
const changeFromYearStart = computed(() =>
  formatChange(currentValue.value, yearStartValue.value, xirrDecimals),
);

/** 明细表行（倒序展示 + 前值索引配对，等价 React 模板内的 prev 计算） */
const detailRows = computed(() => {
  const data = seriesData.value;
  return [...data].reverse().map((p, idx) => ({
    point: p,
    prev: data[data.length - idx - 2] ?? null,
  }));
});

const trendTitle = computed(() => `XIRR 趋势 — ${labelOf(dimension.value.granularity)}`);
</script>

<script lang="ts">
/** 维度中文标签（模块内辅助，与 GRANULARITY_OPTIONS 文案一致） */
function labelOf(g: string): string {
  switch (g) {
    case 'day':
      return '按日';
    case 'week':
      return '按周';
    case 'month':
      return '按月';
    case 'year':
      return '按年';
    default:
      return '';
  }
}

/** 简单按年份分组的聚合（取每年最后一条非空 XIRR） */
function aggregateByYear(data: XirrSeriesPoint[]): XirrSeriesPoint[] {
  const map = new Map<number, XirrSeriesPoint>();
  for (const p of data) {
    const year = Number(p.date.slice(0, 4));
    if (Number.isNaN(year)) continue;
    const existing = map.get(year);
    if (!existing || p.date > existing.date) {
      map.set(year, { ...p, label: String(year) });
    }
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, p]) => p);
}
</script>

<template>
  <!-- 无组合：引导选择（对齐 React 条件渲染分支） -->
  <Card v-if="!currentPortfolioId" class="mx-auto max-w-md">
    <CardContent class="py-10 text-center text-sm text-muted-foreground">
      请先选择一个投资组合
    </CardContent>
  </Card>

  <div v-else class="space-y-6">
    <PageHeader
      title="收益分析（XIRR）"
      description="查看累计 XIRR 在不同时间维度下的趋势与年度对比"
    />

    <!--
      问题③：与净值分析页保持同一外层结构。
      DimensionSwitcher 内部是 md:justify-between —— 作为全宽块级元素时会把
      起止日期推到最右端。包一层 flex 容器后它变成「按内容收缩」的 flex item，
      justify-between 失去多余空间从而不再生效，日期控件紧跟维度 Tabs 左对齐。
    -->
    <div class="flex flex-wrap items-end gap-4">
      <!-- 受控绑定：变更统一走 handleDimensionChange（先判交互守卫再写入），勿改回 v-model -->
      <DimensionSwitcher
        :model-value="dimension"
        :quick-ranges="QUICK_RANGE_OPTIONS"
        :all-range-start="baseDate"
        @update:model-value="handleDimensionChange"
      />
    </div>

    <!-- 当前累计 XIRR + 较年初 -->
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <MetricCard
        size="hero"
        label="当前累计 XIRR"
        :value="formatPercent(currentValue, 2, { decimals: xirrDecimals })"
        :description="
          latest.data.value
            ? `最新日期 ${formatDate(latest.data.value.date)}`
            : '暂无数据'
        "
      />
      <MetricCard
        size="hero"
        label="较年初变化"
        :value="changeFromYearStart"
        :trend="changeFromYearStart.startsWith('-') ? 'down' : 'up'"
        description="单位：百分点（pp）"
      />
    </div>

    <!-- XIRR 折线图（null 断线） -->
    <XirrTrendChart
      :data="seriesData"
      :loading="series.isLoading.value"
      :title="trendTitle"
      :connect-nulls="false"
    />

    <!-- 年度柱状图（当年柱高亮，DASH-P1-05 验收 2） -->
    <YearlyBarChart
      v-if="dimension.granularity !== 'year' && seriesData.length > 0"
      :data="aggregateByYear(seriesData)"
      title="年度 XIRR 对比"
      highlight-current-year
    />

    <!-- 明细表 -->
    <Card>
      <CardHeader>
        <CardTitle class="text-base">明细数据</CardTitle>
        <CardDescription>XIRR 与环比变化</CardDescription>
      </CardHeader>
      <CardContent>
        <Skeleton v-if="series.isLoading.value" class="h-40 w-full" />
        <div
          v-else-if="seriesData.length === 0"
          class="py-10 text-center text-sm text-muted-foreground"
        >
          暂无数据
        </div>
        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>日期</TableHead>
              <TableHead>XIRR</TableHead>
              <TableHead>环比变化</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow
              v-for="(row, idx) in detailRows"
              :key="`${row.point.date}-${idx}`"
            >
              <TableCell class="font-mono text-sm tabular-nums">
                {{ row.point.label }}
              </TableCell>
              <TableCell class="font-mono tabular-nums">
                {{ formatPercent(row.point.xirrValue, 2, { decimals: xirrDecimals }) }}
              </TableCell>
              <TableCell class="font-mono text-xs tabular-nums">
                {{ formatChange(row.point.xirrValue, row.prev?.xirrValue ?? null, xirrDecimals) }}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  </div>
</template>
