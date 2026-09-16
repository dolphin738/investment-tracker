/**
 * modules/overview/composables/use-dashboard-overview.ts — 概览页状态/查询聚合
 *
 * 纯位置性拆分（S4）：平移自 DashboardPage.vue 的 <script>（原 L23–L370），
 * 零行为变更。原页面仅保留骨架分支 + 页头 + 区二筛选栏/hero 图 + 装配两个子组件
 * + 两个录入弹窗（见 DashboardPage.vue）。
 *
 * 本模块集中：
 *   1. 全部状态（组合/偏好/查询维度与范围/录入弹窗状态）
 *   2. 全部查询（overview / nav·xirr 序列 / 最新 nav·xirr / 现金余额 / 近期出入金 /
 *      组合摘要）
 *   3. 全部 computed（ov / 8 指标卡展示模型 / hasNoData / 列表）
 *   4. URL-state 与 range 同步（useUrlState / useRangePreferenceSync）
 *   5. 4 个展示常量（GRANULARITY_TABS / METRIC_GRID_CLASS / TYPE_LABEL /
 *      ONBOARDING_STEPS）
 *   6. 录入弹窗开启动作函数（openCashflow / openTrade）
 *
 * 门面在 setup 中调用一次 useDashboardOverview()，把结果解构后下发给两个子组件（props）。
 */

import { computed, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { buildOverviewMetrics } from '../features/asset-metrics';
import {
  createOverviewSchema,
  type OverviewQueryState,
} from '../features/overview-query-params';
import { resolveQuickRange } from '@/modules/query/quick-range';
import { useRangePreferenceSync } from '@/modules/analysis/composables/use-range-preference-sync';
import { ENTRY_BUTTON_LABELS } from '@/constants/entry-button-labels';
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
import { useUrlState } from '@/lib/url-query';
import { QueryGranularity, AggregationMethod } from '@/lib/types';

/** 维度选项 */
export const GRANULARITY_TABS = [
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
export const METRIC_GRID_CLASS = 'grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4';

/** 出入金类型中文映射（BUY=存入，SELL=取出） */
export const TYPE_LABEL: Record<string, string> = {
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

export const ONBOARDING_STEPS: ReadonlyArray<OnboardingStep> = [
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

/**
 * 概览页状态/查询聚合 hook（原 DashboardPage <script>）。
 * 仅在页面 setup 中调用一次，结果下发给子组件。
 */
export function useDashboardOverview() {
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
    () => ov.value?.cumulativeNav ?? latestNav.data.value?.cumulativeNav ?? null,
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

  /** 录入弹窗开启函数（供 TrendGrid 引导卡 / 空态按钮回调） */
  function openCashflow(): void {
    cashflowOpen.value = true;
  }
  function openTrade(): void {
    tradeOpen.value = true;
  }

  return {
    // 组合 / 偏好
    portfolios,
    portfoliosLoading,
    currentPortfolioId,
    // 概览查询态
    overviewLoading,
    overviewIsError,
    overviewRefetch,
    latestNavLoading,
    latestNavError,
    latestNavRefetch,
    ov,
    // URL-state / range 同步
    overviewQuery,
    setOverviewQuery,
    markRangeInteracted,
    startDate,
    endDate,
    baseDate,
    // hero 图
    navSeriesData,
    navSeriesLoading,
    amountThousands,
    amountAbbrev,
    // 录入弹窗状态
    cashflowOpen,
    tradeOpen,
    // 区一指标卡
    assetMetrics,
    returnMetrics,
    // 区二动态体
    hasNoData,
    xirrSeriesData,
    xirrSeriesLoading,
    recentLoading,
    recentItems,
    summaryLoading,
    summaryList,
    xirrDecimals,
    // 弹窗开启回调
    openCashflow,
    openTrade,
  };
}
