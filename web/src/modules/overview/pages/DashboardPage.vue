<script setup lang="ts">
/**
 * modules/overview/pages/DashboardPage.vue — 概览页（PRD §7.4）
 *
 * 平移自 React 版 web/src/pages/dashboard.tsx。
 *
 * 【版面骨架（纯展示分区，不含任何数据逻辑）】
 * 页头 + 新鲜度提示 → 区一「关键指标」→ 区二「趋势分析」，区间距 space-y-8。
 *
 * - 区一「关键指标」：8 指标卡按 group 拆成两个带小标题的分组 ——
 *   「资产构成」4（当前总资产 / 持仓市值 / 现金余额 / 净投入）+「收益表现」4
 *   （累计收益率 / 当年收益率 / 年化XIRR / 累计净值），回答「我有多少 vs 赚了多少」。
 *   分组只是 filter(m => m.group === …) 的展示切分，值与涨跌方向仍由
 *   buildOverviewMetrics 统一构造，页面不参与任何计算。
 * - 区二「趋势分析」：筛选栏（维度 [日][周][月][年] + 共享 DateRangeQuickPicker，
 *   受控回显 URL range）置顶 → 总资产走势图作为 hero 图（含手工记录标记）→
 *   四宫格：净值趋势（累计+当年双线）/ XIRR 趋势 / 近期出入金最近5笔 /
 *   组合表现对比。
 * - 有组合但无数据时，四宫格位置渲染三步引导卡（DASH-P0-06）
 * - 按钮「录入出入金」「录入买卖」→ 分别打开出入金/买卖弹窗
 */

import { computed, ref } from 'vue';
import { ROUTE_PATH } from '@/lib/constants';
import { RouterLink } from 'vue-router';
import { ArrowUpFromLine, ArrowLeftRight, Plus } from 'lucide-vue-next';
import { useQuery } from '@tanstack/vue-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Section, SectionTitle } from '@/components/ui/section';
import MetricCard from '@/components/common/MetricCard.vue';
import XirrTrendChart from '@/components/charts/XirrTrendChart.vue';
import NavTrendChart from '@/components/charts/NavTrendChart.vue';
import TotalAssetTrendChart from '../components/TotalAssetTrendChart.vue';
import FreshnessBanner from '../components/FreshnessBanner.vue';
import PriceFreshnessBadge from '@/modules/holdings/components/PriceFreshnessBadge.vue';
import DateRangeQuickPicker from '@/components/date/DateRangeQuickPicker.vue';
import TableSkeleton from '@/components/common/TableSkeleton.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import PageHeader from '@/components/common/PageHeader.vue';
import CashflowForm from '@/modules/cashflow/components/CashflowForm.vue';
import SecurityTradeForm from '@/modules/security-trade/components/SecurityTradeForm.vue';
import { buildOverviewMetrics } from '../features/asset-metrics';
import {
  createOverviewSchema,
  type OverviewQueryState,
} from '../features/overview-query-params';
import { resolveQuickRange } from '@/modules/query/quick-range';
import { useRangePreferenceSync } from '@/modules/analysis/composables/use-range-preference-sync';
import {
  ENTRY_BUTTON_ICON_CLASS,
  ENTRY_BUTTON_LABELS,
  ENTRY_BUTTON_SIZE,
  ENTRY_BUTTON_VARIANT,
} from '@/constants/entry-button-labels';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { usePreferenceStore } from '@/stores/preference.store';
import { usePortfolios } from '@/modules/portfolio/composables/use-portfolios';
import {
  useLatestXirr,
  useLatestNav,
  useXirrSeries,
  useNavSeries,
} from '../composables/use-query-data';
import { useLatestCashBalance } from '@/modules/cash-balance/composables/use-cash-balances';
import { getOverview, getPortfoliosSummary } from '@/api/overview.api';
import { listTransactions } from '@/api/transaction.api';
import { NavMetric } from '@/api/types';
import { CashFlowType } from '@/lib/types';
import { useUrlState } from '@/lib/url-query';
import { formatPercent, formatCurrency, formatDate, cn } from '@/lib/utils';
import { QueryGranularity, AggregationMethod } from '@/lib/types';

/** 维度选项 */
const GRANULARITY_TABS = [
  { value: 'day', label: '日' },
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
  { value: 'year', label: '年' },
] as const;

/**
 * 指标卡网格断点（两个分组共用，保证两行卡片列宽严格对齐）。
 *
 * 移动端强制 1 列：「当前总资产 ¥1,234,567.89」在 2 列窄栏里会溢出/换行；
 * >=640px 两列、>=768px 起四列，8 张卡稳定排成两行。
 */
const METRIC_GRID_CLASS = 'grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4';

/** 出入金类型中文映射（BUY=存入，SELL=取出） */
const TYPE_LABEL: Record<string, string> = {
  BUY: '存入',
  SELL: '取出',
};

/** 空态引导步骤（DASH-P0-06：有组合但无数据时的三步引导） */
interface OnboardingStep {
  /** 步骤序号（展示用） */
  index: number;
  /** 步骤标题 */
  title: string;
  /** 步骤说明 */
  description: string;
  /** 可选行动按钮文案；缺省表示该步无按钮 */
  actionLabel?: string;
  /** 行动类型，决定点击后打开哪个录入弹窗 */
  action?: 'cashflow' | 'trade';
}

const ONBOARDING_STEPS: ReadonlyArray<OnboardingStep> = [
  {
    index: 1,
    title: '创建组合',
    description: '已完成。可在「账户 → 我的组合」中继续新建或调整组合。',
  },
  {
    index: 2,
    title: '录入首笔存入',
    description: '记录第一笔本金存入，作为净值与 XIRR 的计算起点。',
    // 决策 H：文案取自统一字典，禁止写字面量
    actionLabel: ENTRY_BUTTON_LABELS.cashFlow,
    action: 'cashflow',
  },
  {
    index: 3,
    title: '录入证券买卖 / 现价',
    description: '录入买卖流水并维护现价，持仓、净值与收益将自动推导。',
    actionLabel: ENTRY_BUTTON_LABELS.securityTrade,
    action: 'trade',
  },
];

// ============================================================================
// 状态与数据
// ============================================================================

const portfolioStore = usePortfolioStore();
const preferenceStore = usePreferenceStore();

/** 当前选中组合 id */
const currentPortfolioId = computed(() => portfolioStore.currentPortfolioId);
/** 「全部」快捷项的起点 = 组合首个交易日（问题②） */
const baseDate = computed(() => portfolioStore.currentPortfolioBaseDate);

const { data: portfoliosData, isLoading: portfoliosLoading } = usePortfolios();
const portfolios = computed(() => portfoliosData.value ?? []);

// 录入弹窗状态
const cashflowOpen = ref(false);
const tradeOpen = ref(false);

// 偏好（SET-P0-02 验收 4：启动时读取偏好作为默认值；
// PreferenceBootstrap 已在布局层把服务端偏好同步进 preference.store）
const navDecimals = computed(() => preferenceStore.getPreference('navDecimals'));
const xirrDecimals = computed(() => preferenceStore.getPreference('xirrDecimals'));
const amountThousands = computed(() =>
  preferenceStore.getPreference('amountThousands'),
);
const amountAbbrev = computed(() =>
  preferenceStore.getPreference('amountAbbrev'),
);

// 查询维度 / 范围状态（T03 · URL 持久化，AL-014）：
// g / range / from / to 走 useUrlState —— 默认值不写入 URL、刷新/分享/前进后退可还原。
const [overviewQuery, setOverviewQuery] = useUrlState<OverviewQueryState>(
  createOverviewSchema(
    preferenceStore.getPreference('defaultGranularity'),
    preferenceStore.getPreference('defaultDateRange'),
  ),
);

const { startDate, endDate } = (() => {
  // range=custom（分享链接）时直接采用 from/to；否则按快捷范围解析（Q-6 乙）
  // 「全部」以组合首个交易日为起点；组合尚无首笔买入时回落兜底值
  const resolved = computed(() => {
    if (
      overviewQuery.range === 'custom' &&
      overviewQuery.from &&
      overviewQuery.to
    ) {
      return { startDate: overviewQuery.from, endDate: overviewQuery.to };
    }
    return resolveQuickRange(overviewQuery.range, {
      allRangeStart: baseDate.value ?? undefined,
    });
  });
  return {
    startDate: computed(() => resolved.value.startDate),
    endDate: computed(() => resolved.value.endDate),
  };
})();

/**
 * 偏好默认范围对齐守卫（INC-01 决策 E · 统一范式）。
 *
 * URL 未显式带 range 且用户未交互时补齐一次默认范围；
 * 用户手动改过范围后不再对齐（避免选择被弹回）。
 */
const { markInteracted: markRangeInteracted } = useRangePreferenceSync({
  currentQuick: () => overviewQuery.range,
  currentStartDate: startDate,
  allRangeStart: baseDate,
  urlParamKeys: ['range', 'from', 'to'],
  onAlign: (alignment) =>
    setOverviewQuery({
      range: alignment.quick as OverviewQueryState['range'],
      from: '',
      to: '',
    }),
});

// 概览聚合数据
const overview = useQuery({
  queryKey: computed(() => ['overview', currentPortfolioId.value]),
  queryFn: () => getOverview(currentPortfolioId.value!),
  enabled: computed(() => Boolean(currentPortfolioId.value)),
  staleTime: 30 * 1000,
});

// vue-query 返回对象的属性是 ref，模板嵌套访问（overview.isLoading）不会自动解包，
// 解构为顶层绑定后模板才能拿到布尔值/数组（与官方用法一致）
const {
  isLoading: overviewLoading,
  isError: overviewIsError,
  refetch: overviewRefetch,
} = overview;

// 净值/XIRR 序列（接入维度）
const xirrSeriesParams = computed(() => ({
  granularity: overviewQuery.g as QueryGranularity,
  startDate: startDate.value,
  endDate: endDate.value,
  aggregation: AggregationMethod.LAST,
}));
const xirrSeries = useXirrSeries(currentPortfolioId, xirrSeriesParams);
const {
  data: xirrSeriesData,
  isLoading: xirrSeriesLoading,
} = xirrSeries;

const navSeriesParams = computed(() => ({
  granularity: overviewQuery.g as QueryGranularity,
  startDate: startDate.value,
  endDate: endDate.value,
  aggregation: AggregationMethod.LAST,
  // 缺陷4-B：明确请求「对比」双线，使累计+当年净值均下发（避免单指标口径下
  // cumulativeNav/yearNav 解包为 undefined → 净值趋势提示「数据不足」）
  metric: NavMetric.BOTH,
}));
const navSeries = useNavSeries(currentPortfolioId, navSeriesParams);
// 序列数据/加载态解构（模板需要数组与布尔值，嵌套 ref 不自动解包）
const {
  data: navSeriesData,
  isLoading: navSeriesLoading,
} = navSeries;

// 最新净值/XIRR
const latestXirr = useLatestXirr(currentPortfolioId);
const latestNav = useLatestNav(currentPortfolioId);
// 最新净值加载/失败态（同上：解构为顶层绑定供模板解包）
const {
  isLoading: latestNavLoading,
  isError: latestNavError,
  refetch: latestNavRefetch,
} = latestNav;
// 最新现金余额（概览 8 卡之「现金余额」卡，融合自出入金页【A】）
const latestBalance = useLatestCashBalance(currentPortfolioId);

// 近期出入金（最新 5 笔）
const recentTransactions = useQuery({
  queryKey: computed(() => ['transactions', 'recent', currentPortfolioId.value]),
  queryFn: () =>
    listTransactions(currentPortfolioId.value!, { page: 1, pageSize: 5 }),
  enabled: computed(() => Boolean(currentPortfolioId.value)),
  staleTime: 30 * 1000,
});
const { isLoading: recentLoading } = recentTransactions;

// 组合表现对比（全部组合摘要）
const portfolioSummary = useQuery({
  queryKey: ['portfolios', 'summary'],
  queryFn: () => getPortfoliosSummary(),
  staleTime: 60 * 1000,
});
const { isLoading: summaryLoading } = portfolioSummary;

// ============================================================================
// 概览 8 指标卡展示模型（buildOverviewMetrics 已有完整空值兜底）
// ============================================================================

const ov = computed(() => overview.data.value);
const cumulativeXirr = computed(
  () => ov.value?.xirr ?? latestXirr.data.value?.xirrValue ?? null,
);
const totalAsset = computed(() => ov.value?.totalAsset ?? null);
const cumulativeNav = computed(
  () =>
    ov.value?.cumulativeNav ?? latestNav.data.value?.cumulativeNav ?? null,
);
const yearNav = computed(
  () => ov.value?.yearNav ?? latestNav.data.value?.yearNav ?? null,
);
const netInvested = computed(() => ov.value?.netInvested ?? null);
const totalReturnRate = computed(
  () =>
    ov.value?.totalReturnRate ??
    (cumulativeNav.value !== null ? Number(cumulativeNav.value) - 1 : null),
);
const yearReturnRate = computed(
  () =>
    ov.value?.yearReturnRate ??
    (yearNav.value !== null ? Number(yearNav.value) - 1 : null),
);

const overviewMetrics = computed(() =>
  buildOverviewMetrics({
    totalAsset: totalAsset.value,
    latestDate: ov.value?.latestDate ?? null,
    latestSource: ov.value?.latestSource ?? null,
    marketValue: ov.value?.holdingsSummary?.totalMarketValue ?? null,
    cashBalance: latestBalance.data.value?.amount ?? null,
    cashAsOf: latestBalance.data.value?.asOf ?? null,
    netInvested: netInvested.value,
    totalReturnRate: totalReturnRate.value,
    yearReturnRate: yearReturnRate.value,
    xirr: cumulativeXirr.value,
    cumulativeNav: cumulativeNav.value,
    yearNav: yearNav.value,
    format: { thousands: amountThousands.value, abbreviate: amountAbbrev.value },
    navDecimals: navDecimals.value,
    xirrDecimals: xirrDecimals.value,
  }),
);

/** 展示层分组：8 卡按 group 切成「资产构成 / 收益表现」两组（纯 filter，不改值） */
const assetMetrics = computed(() =>
  overviewMetrics.value.filter((m) => m.group === 'asset'),
);
const returnMetrics = computed(() =>
  overviewMetrics.value.filter((m) => m.group === 'return'),
);

/**
 * DASH-P0-06：「有组合但无数据」判定。
 * overview 加载完成（非 isLoading）且无返回数据，即视为该组合尚未录入任何数据。
 * 额外排除 isError：请求失败同样满足 !data，但那是「加载失败」而非「没有数据」，
 * 误判会把错误伪装成空态并盖掉仍可正常加载的净值/XIRR 图表。
 */
const hasNoData = computed(
  () =>
    !overview.isLoading.value &&
    !overview.isError.value &&
    !overview.data.value,
);

/** 近期出入金列表 */
const recentItems = computed(
  () => recentTransactions.data.value?.items ?? [],
);

/** 组合摘要列表 */
const summaryList = computed(() => portfolioSummary.data.value ?? []);
</script>

<template>
  <div class="space-y-8">
    <!-- ===== 加载态：组合列表 ===== -->
    <div v-if="portfoliosLoading" class="space-y-6">
      <PageHeader title="概览" description="加载中…" />
      <Skeleton class="h-40 w-full" />
    </div>

    <!-- ===== 无组合 ===== -->
    <EmptyState
      v-else-if="portfolios.length === 0"
      title="欢迎，先创建您的第一个投资组合"
      description="创建组合后即可开始录入出入金和买卖数据。"
    />

    <!-- ===== 未选组合 ===== -->
    <Card v-else-if="!currentPortfolioId" class="mx-auto max-w-md">
      <CardContent class="py-10 text-center text-sm text-muted-foreground">
        请先在顶部选择一个投资组合
      </CardContent>
    </Card>

    <!-- ===== 双查询同时加载中 ===== -->
    <div v-else-if="overviewLoading && latestNavLoading" class="space-y-6">
      <PageHeader title="概览" description="加载中…" />
      <Card>
        <CardContent class="space-y-3">
          <Skeleton class="h-7 w-40" />
          <Skeleton class="h-24 w-full" />
          <Skeleton class="h-24 w-full" />
        </CardContent>
      </Card>
    </div>

    <!-- ===== 双查询均失败 ===== -->
    <div v-else-if="overviewIsError && latestNavError" class="space-y-6">
      <PageHeader title="概览" />
      <Card>
        <CardContent class="flex flex-col items-center gap-4 py-12">
          <p class="text-sm text-destructive">数据加载失败，请稍后重试</p>
          <Button
            variant="outline"
            @click="() => { overviewRefetch(); latestNavRefetch(); }"
          >
            重新加载
          </Button>
        </CardContent>
      </Card>
    </div>

    <template v-else>
      <!-- ===== 页头 + 新鲜度提示 ===== -->
      <div class="space-y-4">
        <PageHeader
          title="概览"
          :description="
            ov?.latestDate ? `数据截止 ${ov.latestDate}` : '最近 12 个月收益概览'
          "
        >
          <template #actions>
            <div class="flex items-center gap-2">
              <!-- Q3：行情数据新鲜度徽标（与 FreshnessBanner 后端判定提示互补） -->
              <PriceFreshnessBadge :portfolio-id="currentPortfolioId" />
              <Button
                variant="default"
                size="sm"
                @click="cashflowOpen = true"
              >
                <Plus :class="ENTRY_BUTTON_ICON_CLASS" />
                {{ ENTRY_BUTTON_LABELS.cashFlow }}
              </Button>
              <Button
                variant="default"
                size="sm"
                @click="tradeOpen = true"
              >
                <Plus :class="ENTRY_BUTTON_ICON_CLASS" />
                {{ ENTRY_BUTTON_LABELS.securityTrade }}
              </Button>
            </div>
          </template>
        </PageHeader>

        <!-- 数据新鲜度提示条（DASH-P1-03 · 后端判定，isStale=false 不渲染） -->
        <FreshnessBanner
          v-if="ov?.freshness"
          :portfolio-id="currentPortfolioId"
          :freshness="ov.freshness"
        />
      </div>

      <!-- ===== 区一「关键指标」：8 卡按 group 分两组 ===== -->
      <Section title="关键指标" description="资产家底与收益表现一眼看全">
        <!-- 资产构成 4 —— 首张「当前总资产」用极轻描边点题 -->
        <div class="space-y-3">
          <SectionTitle>资产构成</SectionTitle>
          <div :class="METRIC_GRID_CLASS">
            <MetricCard
              v-for="m in assetMetrics"
              :key="m.key"
              :label="m.title"
              :value="m.value"
              :description="m.description"
              :trend="m.trend"
              :class="m.key === 'total-asset' ? 'border-primary/30' : undefined"
            />
          </div>
        </div>

        <!-- 收益表现 4 -->
        <div class="space-y-3">
          <SectionTitle>收益表现</SectionTitle>
          <div :class="METRIC_GRID_CLASS">
            <MetricCard
              v-for="m in returnMetrics"
              :key="m.key"
              :label="m.title"
              :value="m.value"
              :description="m.description"
              :trend="m.trend"
            />
          </div>
        </div>
      </Section>

      <!-- ===== 区二「趋势分析」：筛选栏 → hero 走势图 → 四宫格 ===== -->
      <Section title="趋势分析" description="维度与区间对本区所有图表统一生效">
        <!--
          维度切换 + 范围筛选（共享 DateRangeQuickPicker，受控回显 URL range）。
          移动端纵向堆叠，>=640px 回到一行，与其他分析页一致。
        -->
        <div class="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end">
          <Tabs
            :model-value="overviewQuery.g"
            class="w-auto"
            @update:model-value="
              (v) => setOverviewQuery({ g: v as OverviewQueryState['g'] })
            "
          >
            <TabsList>
              <TabsTrigger
                v-for="tab in GRANULARITY_TABS"
                :key="tab.value"
                :value="tab.value"
              >
                {{ tab.label }}
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <DateRangeQuickPicker
            :quick="overviewQuery.range === 'custom' ? undefined : overviewQuery.range"
            :start-date="startDate"
            :end-date="endDate"
            :all-range-start="baseDate"
            @change="
              (r) => {
                markRangeInteracted();
                setOverviewQuery(
                  r.quick
                    ? { range: r.quick as OverviewQueryState['range'], from: '', to: '' }
                    : { range: 'custom', from: r.startDate, to: r.endDate },
                );
              }
            "
          />
        </div>

        <!-- hero 图：总资产走势（含手工记录标记） -->
        <TotalAssetTrendChart
          :data="navSeriesData ?? []"
          :loading="navSeriesLoading"
          :portfolio-id="currentPortfolioId"
          :start-date="startDate"
          :end-date="endDate"
          :amount-thousands="amountThousands"
          :amount-abbrev="amountAbbrev"
        />

        <!-- 有组合但无数据：三步引导（DASH-P0-06） -->
        <Card v-if="hasNoData">
          <CardHeader>
            <CardTitle class="text-base">开始记录你的投资</CardTitle>
            <p class="text-sm text-muted-foreground">
              当前组合还没有任何数据，按下面三步录入即可看到净值、XIRR 与持仓分析。
            </p>
          </CardHeader>
          <CardContent>
            <ol class="grid grid-cols-1 gap-4 md:grid-cols-3">
              <li
                v-for="step in ONBOARDING_STEPS"
                :key="step.index"
                class="flex flex-col gap-2 rounded-lg border bg-muted/30 p-4"
              >
                <div class="flex items-center gap-2">
                  <span
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
                  >
                    {{ step.index }}
                  </span>
                  <span class="text-sm font-medium">{{ step.title }}</span>
                </div>
                <p class="text-xs leading-relaxed text-muted-foreground">
                  {{ step.description }}
                </p>
                <!-- INC-05：引导卡按钮与页头主入口同规格（主色 + sm + Plus） -->
                <Button
                  v-if="step.actionLabel"
                  size="sm"
                  variant="default"
                  class="mt-auto self-start"
                  @click="step.action === 'trade' ? (tradeOpen = true) : (cashflowOpen = true)"
                >
                  <Plus :class="ENTRY_BUTTON_ICON_CLASS" />
                  {{ step.actionLabel }}
                </Button>
              </li>
            </ol>
          </CardContent>
        </Card>

        <!-- 四宫格（仅在有数据时渲染） -->
        <div v-if="!hasNoData" class="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <NavTrendChart
            :data="navSeriesData ?? []"
            :loading="navSeriesLoading"
            title="净值趋势（累计 + 当年）"
          />
          <XirrTrendChart
            :data="xirrSeriesData ?? []"
            :loading="xirrSeriesLoading"
            title="XIRR 趋势"
            :connect-nulls="false"
          />

          <!-- 近期出入金（最近5笔） -->
          <Card>
            <CardHeader class="flex flex-row items-center justify-between">
              <CardTitle class="text-base">近期出入金</CardTitle>
              <!-- DASH-P0-05：跳转出入金页查看完整流水 -->
              <div class="flex items-center gap-3">
                <RouterLink
                  :to="ROUTE_PATH.TRANSACTIONS"
                  class="text-xs text-muted-foreground hover:underline"
                >
                  查看全部
                </RouterLink>
                <ArrowLeftRight class="h-4 w-4 text-muted-foreground" />
              </div>
            </CardHeader>
            <CardContent>
              <TableSkeleton v-if="recentLoading" :rows="3" :cols="3" />
              <div v-else-if="recentItems.length > 0" class="space-y-3">
                <div
                  v-for="tx in recentItems"
                  :key="tx.id"
                  class="flex items-center justify-between border-b pb-2 last:border-0 last:pb-0"
                >
                  <div class="flex items-center gap-3">
                    <span class="text-sm text-muted-foreground">
                      {{ formatDate(tx.date, 'MM-dd') }}
                    </span>
                    <span
                      :class="cn(
                        'text-xs font-medium',
                        tx.type === CashFlowType.BUY
                          ? 'text-up'
                          : 'text-down',
                      )"
                    >
                      {{ TYPE_LABEL[tx.type] || tx.type }}
                    </span>
                  </div>
                  <div class="flex items-center gap-3">
                    <span class="text-sm font-medium tabular-nums">
                      {{
                        (tx.type === CashFlowType.BUY ? '+' : '-') +
                          formatCurrency(tx.amount, 2, {
                            thousands: amountThousands,
                            abbreviate: amountAbbrev,
                          })
                      }}
                    </span>
                    <span
                      v-if="tx.note"
                      class="max-w-[120px] truncate text-xs text-muted-foreground"
                    >
                      {{ tx.note }}
                    </span>
                  </div>
                </div>
              </div>
              <EmptyState
                v-else
                title="还没有出入金记录"
                description="录入第一笔出入金开始跟踪收益"
              >
                <template #action>
                  <Button
                    variant="default"
                    size="sm"
                    @click="cashflowOpen = true"
                  >
                    <Plus :class="ENTRY_BUTTON_ICON_CLASS" />
                    {{ ENTRY_BUTTON_LABELS.cashFlow }}
                  </Button>
                </template>
              </EmptyState>
            </CardContent>
          </Card>

          <!-- 组合表现对比 -->
          <Card>
            <CardHeader class="flex flex-row items-center justify-between">
              <CardTitle class="text-base">组合表现对比</CardTitle>
              <ArrowUpFromLine class="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <TableSkeleton v-if="summaryLoading" :rows="3" :cols="4" />
              <div v-else-if="summaryList.length > 0" class="space-y-2">
                <div
                  v-for="p in summaryList"
                  :key="p.id"
                  class="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2 text-sm"
                >
                  <span class="font-medium">{{ p.name }}</span>
                  <div class="flex items-center gap-4">
                    <span class="tabular-nums">
                      {{
                        formatCurrency(p.totalAsset, 2, {
                          thousands: amountThousands,
                          abbreviate: amountAbbrev,
                        })
                      }}
                    </span>
                    <!-- 用 != null 同时排除 null 与 undefined：
                        后端已返回该字段但仍可能为 null（尚无 DailyNav），
                        旧写法 !== null 会放行 undefined 并渲染出 NaN%。 -->
                    <span
                      v-if="p.cumulativeReturnRate != null"
                      :class="cn(
                        'tabular-nums',
                        Number(p.cumulativeReturnRate) >= 0
                          ? 'text-up'
                          : 'text-down',
                      )"
                    >
                      {{
                        formatPercent(p.cumulativeReturnRate, 2, {
                          decimals: xirrDecimals,
                        })
                      }}
                    </span>
                    <span v-if="p.xirr != null" class="text-xs text-muted-foreground">
                      XIRR
                      {{ formatPercent(p.xirr, 2, { decimals: xirrDecimals }) }}
                    </span>
                  </div>
                </div>
              </div>
              <div v-else class="py-10 text-center text-sm text-muted-foreground">
                暂无组合数据
              </div>
            </CardContent>
          </Card>
        </div>
      </Section>

      <!-- 录入出入金弹窗 -->
      <Dialog
        :open="cashflowOpen"
        @update:open="(v: boolean) => (cashflowOpen = v)"
      >
        <DialogContent class="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{{ ENTRY_BUTTON_LABELS.cashFlow }}</DialogTitle>
          </DialogHeader>
          <CashflowForm
            :portfolio-id="currentPortfolioId"
            :on-success="() => (cashflowOpen = false)"
          />
        </DialogContent>
      </Dialog>

      <!-- 录入买卖弹窗 -->
      <Dialog
        :open="tradeOpen"
        @update:open="(v: boolean) => (tradeOpen = v)"
      >
        <DialogContent class="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{{ ENTRY_BUTTON_LABELS.securityTrade }}</DialogTitle>
          </DialogHeader>
          <!-- SecurityTradeForm：录入买卖流水并维护现价（对齐 React dashboard 用法，
               success → 关闭弹窗；持仓、净值与收益自动推导） -->
          <SecurityTradeForm
            :portfolio-id="currentPortfolioId"
            @success="tradeOpen = false"
          />
        </DialogContent>
      </Dialog>
    </template>
  </div>
</template>
