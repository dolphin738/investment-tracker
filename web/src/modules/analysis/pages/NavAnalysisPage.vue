<script setup lang="ts">
/**
 * modules/analysis/pages/NavAnalysisPage.vue — 净值分析页（PRD §7.6）
 *
 * 平移自 React 版 web/src/pages/nav-analysis.tsx，行为契约一致：
 * - 维度切换 + 指标单选（累计净值/当年净值/对比）
 * - 当前累计净值/当年净值/累计收益/当年收益
 * - 净值趋势双线图（按指标筛选）
 * - 月度收益热力图（正红负绿色阶）
 * - 每日净值明细表：日期/累计净值/当年净值/每日收益/收益百分比/份额
 *   （每日收益 =（当日累计净值 - 前日累计净值）x 前日份额；正红负绿）
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import DimensionSwitcher from '../components/DimensionSwitcher.vue';
import { toDimensionQueryParams, type DimensionSwitcherValue } from '../features/dimension';
import { QUICK_RANGE_OPTIONS, resolveQuickRange } from '@/modules/query/quick-range';
import { useDefaultDateRange } from '@/modules/query/use-default-date-range';
import { useRangePreferenceSync } from '../composables/use-range-preference-sync';
import { useLatestNav, useNavSeries } from '../composables/use-query-data';
import NavTrendChart from '@/components/charts/NavTrendChart.vue';
import MonthlyHeatmap from '@/components/charts/MonthlyHeatmap.vue';
import PageHeader from '@/components/common/PageHeader.vue';
import MetricCard from '@/components/common/MetricCard.vue';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { usePreferenceStore } from '@/stores/preference.store';
import { formatDecimal, formatPercent, formatCurrency, formatDate } from '@/lib/utils';
import { NavMetric, type NavMetric as NavMetricType } from '@/lib/types';
import {
  AggregationMethod,
  QueryGranularity,
  type NavSeriesPoint,
} from '@/lib/types';
import { computeDailyDetails } from './nav-daily-details';

/** 指标单选选项 */
const METRIC_OPTIONS = [
  { value: NavMetric.CUMULATIVE, label: '累计净值' },
  { value: NavMetric.YEAR, label: '当年净值' },
  { value: NavMetric.BOTH, label: '对比' },
] as const;

const portfolioStore = usePortfolioStore();
// 「全部」快捷项的起点 = 组合首个交易日（问题②）
const currentPortfolioId = computed(() => portfolioStore.currentPortfolioId);
const baseDate = computed(() => portfolioStore.currentPortfolioBaseDate);

const preferenceStore = usePreferenceStore();

// I-04：默认日期范围 = 偏好（URL 无 range 参数时），非法/空回落 '1y'
const defaultRange = useDefaultDateRange();
// 维度初始值（SET-P0-02 验收 4：读取偏好 defaultGranularity 作为默认维度）
const navDecimals = preferenceStore.getPreference('navDecimals');
const xirrDecimals = preferenceStore.getPreference('xirrDecimals');
const amountThousands = preferenceStore.getPreference('amountThousands');
const amountAbbrev = preferenceStore.getPreference('amountAbbrev');

const initialRange = resolveQuickRange(defaultRange.value, {
  allRangeStart: baseDate.value ?? undefined,
});

// 与 React useState 一致：初始值一次性定格，偏好到达后的纠正交给对齐守卫
const dimension = ref<DimensionSwitcherValue>({
  granularity: preferenceStore.getPreference('defaultGranularity') as QueryGranularity,
  startDate: initialRange.startDate,
  endDate: initialRange.endDate,
  // ANL-P0-03：默认聚合读偏好（SET-P0-02 验收4），与 XIRR 页现状一致
  aggregation: preferenceStore.getPreference('aggregation') as AggregationMethod,
  // INC-01：快捷范围受控回显，首帧取偏好回落值（'1y'），偏好到达后由对齐 watch 纠正
  quick: defaultRange.value,
});
const metric = ref<NavMetricType>(NavMetric.BOTH);

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
const dimensionParams = computed(() => toDimensionQueryParams(dimension.value));

const seriesParams = computed(() => ({ ...dimensionParams.value, metric: metric.value }));
const series = useNavSeries(currentPortfolioId, seriesParams);
const latest = useLatestNav(currentPortfolioId);

// 热力图 + 每日明细表固定使用日维度数据（独立查询）。
// 注意：这里是技术必需（每日收益/月度热力图依赖日粒度），不是用户偏好，
// 因此不读取 defaultGranularity，保持 DAY 硬编码。
const dayParams = computed(() => ({
  ...dimensionParams.value,
  granularity: QueryGranularity.DAY,
  metric: metric.value,
}));
const daySeries = useNavSeries(currentPortfolioId, dayParams);

const seriesData = computed<NavSeriesPoint[]>(() => series.data.value ?? []);
const dayData = computed<NavSeriesPoint[]>(() => daySeries.data.value ?? []);

// 问题④：不再把未选中指标置 null（那样 series 仍在，legend/tooltip 会多出
// 一个恒为「数据不足」的条目）。改为原样下发数据，由图表按 metric 决定
// 「注册哪几条 series」。

const dailyDetails = computed(() => computeDailyDetails(dayData.value));

const latestCumulativeNav = computed(() => latest.data.value?.cumulativeNav ?? null);
const latestYearNav = computed(() => latest.data.value?.yearNav ?? null);
const totalReturn = computed(() =>
  latestCumulativeNav.value !== null ? latestCumulativeNav.value - 1 : null,
);
const yearReturn = computed(() =>
  latestYearNav.value !== null ? latestYearNav.value - 1 : null,
);

const trendTitle = computed(() =>
  metric.value === NavMetric.CUMULATIVE
    ? '净值趋势（累计净值）'
    : metric.value === NavMetric.YEAR
      ? '净值趋势（当年净值）'
      : '净值趋势（累计 + 当年双线对比）',
);
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
      title="净值分析"
      description="查看累计净值、当年净值趋势及月度收益分布"
    />

    <div class="flex flex-wrap items-end gap-4">
      <!-- 受控绑定：变更统一走 handleDimensionChange（先判交互守卫再写入），勿改回 v-model -->
      <DimensionSwitcher
        :model-value="dimension"
        :quick-ranges="QUICK_RANGE_OPTIONS"
        :all-range-start="baseDate"
        @update:model-value="handleDimensionChange"
      />
      <div class="space-y-1.5">
        <Label class="text-xs text-muted-foreground">指标</Label>
        <RadioGroup
          v-model="metric"
          orientation="horizontal"
        >
          <RadioGroupItem
            v-for="opt in METRIC_OPTIONS"
            :key="opt.value"
            :value="opt.value"
            :label="opt.label"
          />
        </RadioGroup>
      </div>
    </div>

    <!-- 当前净值摘要（4 卡） -->
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <MetricCard
        label="当前累计净值"
        :value="formatDecimal(latestCumulativeNav, navDecimals)"
        :description="
          latest.data.value
            ? `截至 ${formatDate(latest.data.value.date)}`
            : '暂无数据'
        "
      />
      <MetricCard
        label="当年净值"
        :value="formatDecimal(latestYearNav, navDecimals)"
        description="单位净值口径"
      />
      <MetricCard
        label="累计收益"
        :value="formatPercent(totalReturn, 2, { decimals: xirrDecimals })"
        :trend="(totalReturn ?? 0) < 0 ? 'down' : 'up'"
        description="自成立以来"
      />
      <MetricCard
        label="当年收益"
        :value="formatPercent(yearReturn, 2, { decimals: xirrDecimals })"
        :trend="(yearReturn ?? 0) < 0 ? 'down' : 'up'"
        description="今年以来"
      />
    </div>

    <!-- 净值趋势双线图（按指标） -->
    <NavTrendChart
      :data="seriesData"
      :metric="metric"
      :loading="series.isLoading.value"
      :title="trendTitle"
    />

    <!-- 月度收益热力图 -->
    <MonthlyHeatmap
      :data="dayData"
      :loading="daySeries.isLoading.value"
      title="月度收益热力图"
    />

    <!-- 每日净值明细表 -->
    <Card>
      <CardHeader>
        <CardTitle class="text-base">每日净值明细</CardTitle>
        <CardDescription>
          每日收益 =（当日累计净值 - 前日累计净值）x 前日份额；收益百分比 = 每日收益 / 前一日总资产；正红负绿
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Skeleton v-if="daySeries.isLoading.value" class="h-40 w-full" />
        <div
          v-else-if="dailyDetails.length === 0"
          class="py-10 text-center text-sm text-muted-foreground"
        >
          暂无数据
        </div>
        <div v-else class="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>日期</TableHead>
                <TableHead class="text-right">累计净值</TableHead>
                <TableHead class="text-right">当年净值</TableHead>
                <TableHead class="text-right">每日收益</TableHead>
                <TableHead class="text-right">收益百分比</TableHead>
                <TableHead class="text-right">份额</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow
                v-for="(row, idx) in dailyDetails"
                :key="`${row.date}-${idx}`"
              >
                <TableCell class="whitespace-nowrap font-mono text-sm tabular-nums">
                  {{ row.label }}
                </TableCell>
                <TableCell class="text-right font-mono tabular-nums">
                  {{ formatDecimal(row.cumulativeNav, navDecimals) }}
                </TableCell>
                <TableCell class="text-right font-mono tabular-nums">
                  {{ formatDecimal(row.yearNav, navDecimals) }}
                </TableCell>
                <TableCell
                  :class="
                    row.dailyReturn !== null && row.dailyReturn >= 0
                      ? 'text-right font-mono tabular-nums text-up'
                      : row.dailyReturn !== null && row.dailyReturn < 0
                        ? 'text-right font-mono tabular-nums text-down'
                        : 'text-right font-mono tabular-nums'
                  "
                >
                  {{
                    row.dailyReturn !== null
                      ? `${row.dailyReturn >= 0 ? '+' : ''}${formatCurrency(row.dailyReturn, 2, { thousands: amountThousands, abbreviate: amountAbbrev })}`
                      : '-'
                  }}
                </TableCell>
                <TableCell
                  :class="
                    row.returnRate !== null && row.returnRate >= 0
                      ? 'text-right font-mono tabular-nums text-up'
                      : row.returnRate !== null && row.returnRate < 0
                        ? 'text-right font-mono tabular-nums text-down'
                        : 'text-right font-mono tabular-nums'
                  "
                >
                  {{ formatPercent(row.returnRate, 2, { decimals: xirrDecimals }) }}
                </TableCell>
                <TableCell class="text-right font-mono tabular-nums">
                  {{
                    row.shares !== null
                      // ANL-P0-06 验收3：份额显示 6 位小数（Part E-7 跨网约定）
                      ? Number(row.shares).toLocaleString('zh-CN', {
                          minimumFractionDigits: 6,
                          maximumFractionDigits: 6,
                        })
                      : '-'
                  }}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
        <!-- 明细表脚注（§7.6 草图口径说明；「前一日」= 前一个记录日，F10） -->
        <p class="mt-3 text-xs text-muted-foreground">
          注：每日收益 =（当日累计净值 - 前日累计净值）x 前日份额；收益百分比 = 每日收益 / 前一日总资产；正红负绿。
        </p>
      </CardContent>
    </Card>
  </div>
</template>
