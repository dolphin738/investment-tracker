/**
 * pages/dashboard.tsx — 概览页（PRD §7.4）
 *
 * 【版面骨架（纯展示分区，不含任何数据逻辑）】
 * 页头 + 新鲜度提示 → 区一「关键指标」→ 区二「趋势分析」，区间距 `space-y-8`。
 *
 * - 区一「关键指标」：8 指标卡（融合总资产概览，见
 *   docs/designs/overview-fusion-2026-08-06.md）按 `group` 拆成两个带小标题的分组 ——
 *   「资产构成」4（当前总资产 / 持仓市值 / 现金余额 / 净投入）+「收益表现」4
 *   （累计收益率 / 当年收益率 / 年化XIRR / 累计净值），回答「我有多少 vs 赚了多少」。
 *   ⚠️ 分组只是 `filter(m => m.group === …)` 的展示切分，值与涨跌方向仍由
 *   buildOverviewMetrics 统一构造，页面不参与任何计算。
 * - 区二「趋势分析」：筛选栏（维度 [日][周][月][年] + 共享 DateRangeQuickPicker，
 *   受控回显 URL range）置顶 → 总资产走势图作为 hero 图（含手工记录标记 + manage
 *   深链，融合自出入金页【A】）→ 四宫格：净值趋势（累计+当年双线）/ XIRR 趋势 /
 *   近期出入金最近5笔（带「查看全部」，DASH-P0-05）/ 组合表现对比。
 *   三张时序图收进同一区，避免走势图孤立在卡片与四宫格之间的割裂感。
 * - 有组合但无数据时，四宫格位置渲染三步引导卡（DASH-P0-06）
 * - 按钮「+录入出入金」「+录入买卖」→ 分别打开出入金/买卖弹窗
 *
 * 🔴【Hooks 顺序】`overviewMetrics` 的 useMemo 及其派生变量必须始终位于所有提前
 * `return` 之前（曾因违反此约束导致冷启动白屏，见 5f6ae54）。新增展示层 section
 * 包裹时严禁把任何 hook 挪到早退分支之后。
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowLeftRight,
  Plus,
} from 'lucide-react';
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
import { StatCard } from '@/components/charts/stat-card';
import { XirrTrendChart } from '@/components/charts/xirr-trend-chart';
import { NavTrendChart } from '@/components/charts/nav-trend-chart';
import { DateRangeQuickPicker } from '@/components/date/date-range-quick-picker';
import { TableSkeleton } from '@/components/LoadingSpinner';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { CashflowForm } from '@/features/cashflow/cashflow-form';
import { SecurityTradeForm } from '@/features/security-trade/security-trade-form';
import { FreshnessBanner } from '@/features/overview/freshness-banner';
import { buildOverviewMetrics } from '@/features/overview/asset-metrics';
import { TotalAssetTrendChart } from '@/features/overview/total-asset-trend-chart';
import { createOverviewSchema } from '@/features/overview/overview-query-params';
import type { OverviewQueryState } from '@/features/overview/overview-query-params';
import { resolveQuickRange } from '@/features/query/dimension-switcher';
import {
  usePortfolioBaseDate,
  usePortfolioStore,
} from '@/stores/portfolio.store';
import { usePreferenceStore } from '@/stores/preference.store';
import { usePortfolios } from '@/hooks/use-portfolios';
import {
  useLatestXirr,
  useLatestNav,
  useXirrSeries,
  useNavSeries,
} from '@/hooks/use-query-data';
import { useLatestCashBalance } from '@/hooks/use-cash-balances';
import { useQuery } from '@tanstack/react-query';
import { getOverview, getPortfoliosSummary } from '@/api/overview.api';
import { listTransactions } from '@/api/transaction.api';
import { CashFlowType } from '@investment-tracker/shared';
import { useUrlState } from '@/lib/url-query';
import {
  formatPercent,
  formatCurrency,
  formatDate,
  cn,
} from '@/lib/utils';
import {
  QueryGranularity,
  AggregationMethod,
} from '@investment-tracker/shared';

/** 维度选项 */
const GRANULARITY_TABS = [
  { value: 'day', label: '日' },
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
  { value: 'year', label: '年' },
] as const;

/**
 * 快捷日期范围（DASH-P0-02 / 决策 Q-6 乙）：
 * 统一复用 features/query/dimension-switcher 的 QUICK_RANGE_OPTIONS + resolveQuickRange，
 * 本页不再维护本地副本（原 DATE_RANGE_OPTIONS / resolveDateRange 已移除）。
 * 新 7 项已覆盖偏好 defaultDateRange 的全部取值（1m/3m/1y/ytd/all），无需回落。
 */

/**
 * 指标卡网格断点（两个分组共用，保证两行卡片列宽严格对齐）。
 *
 * 移动端强制 1 列：「当前总资产 ¥1,234,567.89」在 2 列窄栏里会溢出/换行；
 * ≥640px 两列、≥768px 起四列，8 张卡稳定排成两行。
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
  /** 可选行动按钮文案；缺省表示该步无按钮（如「创建组合」在设置页完成） */
  actionLabel?: string;
  /** 行动类型，决定点击后打开哪个录入弹窗 */
  action?: 'cashflow' | 'trade';
}

const ONBOARDING_STEPS: ReadonlyArray<OnboardingStep> = [
  {
    index: 1,
    title: '创建组合',
    description: '已完成。可在「设置 → 组合管理」中继续新建或调整组合。',
  },
  {
    index: 2,
    title: '录入首笔存入',
    description: '记录第一笔本金存入，作为净值与 XIRR 的计算起点。',
    actionLabel: '录入出入金',
    action: 'cashflow',
  },
  {
    index: 3,
    title: '录入证券买卖 / 现价',
    description: '录入买卖流水并维护现价，持仓、净值与收益将自动推导。',
    actionLabel: '录入买卖',
    action: 'trade',
  },
];

export interface OnboardingGuideProps {
  /** 点击「录入出入金」 */
  onOpenCashflow: () => void;
  /** 点击「录入买卖」 */
  onOpenTrade: () => void;
}

/**
 * 有组合但无数据的三步引导卡（DASH-P0-06）。
 *
 * 触发条件由调用方判定：portfolios.length > 0 且 overview 加载完成但无数据。
 * 渲染在四宫格位置，8 指标卡与维度切换器仍正常展示。
 */
function OnboardingGuide({
  onOpenCashflow,
  onOpenTrade,
}: OnboardingGuideProps): JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">开始记录你的投资</CardTitle>
        <p className="text-sm text-muted-foreground">
          当前组合还没有任何数据，按下面三步录入即可看到净值、XIRR 与持仓分析。
        </p>
      </CardHeader>
      <CardContent>
        <ol className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {ONBOARDING_STEPS.map((step) => (
            <li
              key={step.index}
              className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-4"
            >
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                  {step.index}
                </span>
                <span className="text-sm font-medium">{step.title}</span>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {step.description}
              </p>
              {step.actionLabel && (
                <Button
                  size="sm"
                  variant={step.action === 'trade' ? 'default' : 'outline'}
                  className="mt-auto self-start"
                  onClick={
                    step.action === 'trade' ? onOpenTrade : onOpenCashflow
                  }
                >
                  <Plus className="mr-2 h-4 w-4" />
                  {step.actionLabel}
                </Button>
              )}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage(): JSX.Element {
  const currentPortfolioId = usePortfolioStore((s) => s.currentPortfolioId);
  // 「全部」快捷项的起点 = 组合首个交易日（问题②）
  const baseDate = usePortfolioBaseDate();
  const { data: portfolios = [], isLoading: portfoliosLoading } = usePortfolios();

  // 录入弹窗状态
  const [cashflowOpen, setCashflowOpen] = useState(false);
  const [tradeOpen, setTradeOpen] = useState(false);

  // 维度状态（SET-P0-02 验收 4：启动时读取偏好作为默认值；
  // PreferenceBootstrap 已在应用启动时把服务端偏好同步进 preference.store）
  const getPreference = usePreferenceStore((s) => s.getPreference);
  const navDecimals = getPreference('navDecimals');
  const xirrDecimals = getPreference('xirrDecimals');
  const amountThousands = getPreference('amountThousands');
  const amountAbbrev = getPreference('amountAbbrev');
  // 查询维度 / 范围状态（T03 · URL 持久化，AL-014）：
  // g / range / from / to 走 useUrlState —— 默认值不写入 URL、刷新/分享/前进后退可还原。
  const [overviewQuery, setOverviewQuery] = useUrlState<OverviewQueryState>(
    createOverviewSchema(
      getPreference('defaultGranularity'),
      getPreference('defaultDateRange'),
    ),
  );
  const { startDate, endDate } = useMemo(() => {
    // range=custom（分享链接）时直接采用 from/to；否则按快捷范围解析（Q-6 乙）
    if (
      overviewQuery.range === 'custom' &&
      overviewQuery.from &&
      overviewQuery.to
    ) {
      return { startDate: overviewQuery.from, endDate: overviewQuery.to };
    }
    // 「全部」以组合首个交易日为起点（问题②）；组合尚无首笔买入时回落兜底值
    return resolveQuickRange(overviewQuery.range, {
      allRangeStart: baseDate ?? undefined,
    });
  }, [overviewQuery.range, overviewQuery.from, overviewQuery.to, baseDate]);

  // 概览聚合数据
  const overview = useQuery({
    queryKey: ['overview', currentPortfolioId],
    queryFn: () => getOverview(currentPortfolioId!),
    enabled: Boolean(currentPortfolioId),
    staleTime: 30 * 1000,
  });

  // 净值/XIRR 序列（接入维度）
  const xirrSeries = useXirrSeries(currentPortfolioId, {
    granularity: overviewQuery.g as QueryGranularity,
    startDate,
    endDate,
    aggregation: AggregationMethod.LAST,
  });
  const navSeries = useNavSeries(currentPortfolioId, {
    granularity: overviewQuery.g as QueryGranularity,
    startDate,
    endDate,
    aggregation: AggregationMethod.LAST,
  });

  // 最新净值/XIRR
  const latestXirr = useLatestXirr(currentPortfolioId);
  const latestNav = useLatestNav(currentPortfolioId);
  // 最新现金余额（概览 8 卡之「现金余额」卡，融合自出入金页【A】）
  const latestBalance = useLatestCashBalance(currentPortfolioId);

  // 近期出入金（最新 5 笔）
  const recentTransactions = useQuery({
    queryKey: ['transactions', 'recent', currentPortfolioId],
    queryFn: () =>
      listTransactions(currentPortfolioId!, { page: 1, pageSize: 5 }),
    enabled: Boolean(currentPortfolioId),
    staleTime: 30 * 1000,
  });

  // 组合表现对比（全部组合摘要）
  const portfolioSummary = useQuery({
    queryKey: ['portfolios', 'summary'],
    queryFn: () => getPortfoliosSummary(),
    staleTime: 60 * 1000,
  });

  // ===== 概览 8 指标卡原始值（必须位于所有早退之前，遵守 Hooks 规则） =====
  // 这些均为纯计算：ov 为 undefined 时各值自然落 null，
  // buildOverviewMetrics 已有完整空值兜底，上移不改变任何展示语义。
  const ov = overview.data;
  const cumulativeXirr = ov?.xirr ?? latestXirr.data?.xirrValue ?? null;
  const totalAsset = ov?.totalAsset ?? null;
  const cumulativeNav = ov?.cumulativeNav ?? latestNav.data?.cumulativeNav ?? null;
  const yearNav = ov?.yearNav ?? latestNav.data?.yearNav ?? null;
  const netInvested = ov?.netInvested ?? null;
  const totalReturnRate = ov?.totalReturnRate ?? (
    cumulativeNav !== null ? Number(cumulativeNav) - 1 : null
  );
  const yearReturnRate = ov?.yearReturnRate ?? (
    yearNav !== null ? Number(yearNav) - 1 : null
  );

  /**
   * 概览 8 指标卡展示模型（融合总资产概览后由 buildOverviewMetrics 统一构造）。
   *
   * 资产构成 4（当前总资产 / 持仓市值 / 现金余额 / 净投入）+ 收益表现 4
   * （累计收益率 / 当年收益率 / 年化XIRR / 累计净值）。金额/比率/涨跌方向/空态口径
   * 全部收敛到 asset-metrics.ts，页面只负责喂原始值，避免 8 套私有实现漂移。
   */
  const overviewMetrics = useMemo(
    () =>
      buildOverviewMetrics({
        totalAsset,
        latestDate: ov?.latestDate ?? null,
        latestSource: ov?.latestSource ?? null,
        marketValue: ov?.holdingsSummary?.totalMarketValue ?? null,
        cashBalance: latestBalance.data?.amount ?? null,
        cashAsOf: latestBalance.data?.asOf ?? null,
        netInvested,
        totalReturnRate,
        yearReturnRate,
        xirr: cumulativeXirr,
        cumulativeNav,
        yearNav,
        format: { thousands: amountThousands, abbreviate: amountAbbrev },
        navDecimals,
        xirrDecimals,
      }),
    [
      totalAsset,
      ov?.latestDate,
      ov?.latestSource,
      ov?.holdingsSummary?.totalMarketValue,
      latestBalance.data?.amount,
      latestBalance.data?.asOf,
      netInvested,
      totalReturnRate,
      yearReturnRate,
      cumulativeXirr,
      cumulativeNav,
      yearNav,
      amountThousands,
      amountAbbrev,
      navDecimals,
      xirrDecimals,
    ],
  );

  /**
   * 展示层分组：8 卡按 `group` 切成「资产构成 / 收益表现」两组。
   *
   * 纯 filter，不改任何值与涨跌方向 —— 顺序仍由 buildOverviewMetrics 决定，
   * 两组拼起来恰是原来的 8 张卡。放在这里（早退之前、紧邻 overviewMetrics）
   * 是刻意为之：派生变量与其来源相邻，后人重构时不易把它连同 useMemo
   * 一起挪到早退分支之后（那会重演冷启动白屏）。
   */
  const assetMetrics = overviewMetrics.filter((m) => m.group === 'asset');
  const returnMetrics = overviewMetrics.filter((m) => m.group === 'return');

  // ===== 加载态 =====
  if (portfoliosLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="概览" description="加载中…" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  // ===== 无组合 =====
  if (portfolios.length === 0) {
    return (
      <EmptyState
        title="欢迎，先创建您的第一个投资组合"
        description="创建组合后即可开始录入出入金和买卖数据。"
      />
    );
  }

  // ===== 未选组合 =====
  if (!currentPortfolioId) {
    return (
      <Card className="mx-auto max-w-md">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          请先在顶部选择一个投资组合
        </CardContent>
      </Card>
    );
  }

  /**
   * DASH-P0-06：「有组合但无数据」判定。
   * 走到这里 portfolios.length > 0 已由上方早退分支保证；
   * overview 加载完成（非 isLoading）且无返回数据，即视为该组合尚未录入任何数据，
   * 此时用三步引导卡替换四宫格（8 指标卡与维度切换器仍正常渲染）。
   *
   * 额外排除 isError：请求失败同样满足 `!data`，但那是「加载失败」而非「没有数据」，
   * 误判会把错误伪装成空态并盖掉仍可正常加载的净值/XIRR 图表。
   */
  const hasNoData = !overview.isLoading && !overview.isError && !overview.data;

  if (overview.isLoading && latestNav.isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="概览" description="加载中…" />
        <Card>
          <CardContent className="space-y-3">
            <Skeleton className="h-7 w-40" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (overview.isError && latestNav.isError) {
    return (
      <div className="space-y-6">
        <PageHeader title="概览" />
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12">
            <p className="text-sm text-destructive">数据加载失败，请稍后重试</p>
            <Button
              variant="outline"
              onClick={() => {
                overview.refetch();
                latestNav.refetch();
              }}
            >
              重新加载
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* ===== 页头 + 新鲜度提示（同属「页面级信息」，内部用 space-y-4 收紧） ===== */}
      <div className="space-y-4">
        <PageHeader
          title="概览"
          description={
            ov?.latestDate ? `数据截止 ${ov.latestDate}` : '最近 12 个月收益概览'
          }
          actions={
            <div className="flex gap-2">
              <Button
                onClick={() => setCashflowOpen(true)}
                variant="outline"
                size="sm"
              >
                <Plus className="mr-2 h-4 w-4" />
                录入出入金
              </Button>
              <Button onClick={() => setTradeOpen(true)} size="sm">
                <Plus className="mr-2 h-4 w-4" />
                录入买卖
              </Button>
            </div>
          }
        />

        {/* 数据新鲜度提示条（DASH-P1-03 · 后端判定，isStale=false 不渲染） */}
        {ov?.freshness && (
          <FreshnessBanner
            portfolioId={currentPortfolioId}
            freshness={ov.freshness}
          />
        )}
      </div>

      {/* ===== 区一「关键指标」：8 卡按 group 分两组（我有多少 vs 赚了多少） ===== */}
      <Section title="关键指标" description="资产家底与收益表现一眼看全">
        {/* 资产构成 4 —— 首张「当前总资产」用极轻描边点题，不做其它强调 */}
        <div className="space-y-3">
          <SectionTitle>资产构成</SectionTitle>
          <div className={METRIC_GRID_CLASS}>
            {assetMetrics.map((m) => (
              <StatCard
                key={m.key}
                title={m.title}
                value={m.value}
                description={m.description}
                trend={m.trend}
                className={m.key === 'total-asset' ? 'border-primary/30' : undefined}
              />
            ))}
          </div>
        </div>

        {/* 收益表现 4 */}
        <div className="space-y-3">
          <SectionTitle>收益表现</SectionTitle>
          <div className={METRIC_GRID_CLASS}>
            {returnMetrics.map((m) => (
              <StatCard
                key={m.key}
                title={m.title}
                value={m.value}
                description={m.description}
                trend={m.trend}
              />
            ))}
          </div>
        </div>
      </Section>

      {/* ===== 区二「趋势分析」：筛选栏 → hero 走势图 → 四宫格（三张时序图同区） ===== */}
      <Section title="趋势分析" description="维度与区间对本区所有图表统一生效">
        {/*
          维度切换 + 范围筛选（共享 DateRangeQuickPicker，受控回显 URL range）。
          移动端纵向堆叠（Tabs 与日期选择器各占一行，避免挤成两行半），
          ≥640px 回到一行，维度 Tabs 与日期选择器靠左紧凑排列，与其他分析页一致。
        */}
        <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end">
          <Tabs
            value={overviewQuery.g}
            onValueChange={(v) =>
              setOverviewQuery({ g: v as OverviewQueryState['g'] })
            }
            className="w-auto"
          >
            <TabsList>
              {GRANULARITY_TABS.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value}>
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <DateRangeQuickPicker
            quick={overviewQuery.range === 'custom' ? undefined : overviewQuery.range}
            startDate={startDate}
            endDate={endDate}
            allRangeStart={baseDate}
            onChange={(r) =>
              setOverviewQuery(
                r.quick
                  ? { range: r.quick as OverviewQueryState['range'], from: '', to: '' }
                  : { range: 'custom', from: r.startDate, to: r.endDate },
              )
            }
          />
        </div>

        {/* hero 图：总资产走势（融合自出入金页【A】，含手工记录标记 + manage 深链） */}
        <TotalAssetTrendChart
          data={navSeries.data ?? []}
          loading={navSeries.isLoading}
          portfolioId={currentPortfolioId}
          startDate={startDate}
          endDate={endDate}
          amountThousands={amountThousands}
          amountAbbrev={amountAbbrev}
        />

        {/* 有组合但无数据：三步引导（DASH-P0-06） */}
        {hasNoData && (
          <OnboardingGuide
            onOpenCashflow={() => setCashflowOpen(true)}
            onOpenTrade={() => setTradeOpen(true)}
          />
        )}

        {/* 四宫格（仅在有数据时渲染） */}
        {!hasNoData && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <NavTrendChart
              data={navSeries.data ?? []}
              loading={navSeries.isLoading}
              title="净值趋势（累计 + 当年）"
            />
            <XirrTrendChart
              data={xirrSeries.data ?? []}
              loading={xirrSeries.isLoading}
              title="XIRR 趋势"
              connectNulls={false}
            />

            {/* 近期出入金（最近5笔） */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">近期出入金</CardTitle>
                {/* DASH-P0-05：跳转出入金页查看完整流水 */}
                <div className="flex items-center gap-3">
                  <Link
                    to="/cashflows"
                    className="text-xs text-muted-foreground hover:underline"
                  >
                    查看全部
                  </Link>
                  <ArrowLeftRight className="h-4 w-4 text-muted-foreground" />
                </div>
              </CardHeader>
              <CardContent>
                {recentTransactions.isLoading ? (
                  <TableSkeleton rows={3} cols={3} />
                ) : recentTransactions.data &&
                  recentTransactions.data.items.length > 0 ? (
                  <div className="space-y-3">
                    {recentTransactions.data.items.map((tx) => (
                      <div
                        key={tx.id}
                        className="flex items-center justify-between border-b pb-2 last:border-0 last:pb-0"
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-sm text-muted-foreground">
                            {formatDate(tx.date, 'MM-dd')}
                          </span>
                          <span
                            className={cn(
                              'text-xs font-medium',
                              tx.type === CashFlowType.BUY
                                ? 'text-up'
                                : 'text-down',
                            )}
                          >
                            {TYPE_LABEL[tx.type] || tx.type}
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-sm font-medium tabular-nums">
                            {tx.type === CashFlowType.BUY ? '+' : '-'}
                            {formatCurrency(tx.amount, 2, { thousands: amountThousands, abbreviate: amountAbbrev })}
                          </span>
                          {tx.note && (
                            <span className="max-w-[120px] truncate text-xs text-muted-foreground">
                              {tx.note}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title="还没有出入金记录"
                    description="录入第一笔出入金开始跟踪收益"
                    action={
                      <Button size="sm" onClick={() => setCashflowOpen(true)}>
                        <ArrowDownToLine className="mr-2 h-4 w-4" />
                        录入出入金
                      </Button>
                    }
                  />
                )}
              </CardContent>
            </Card>

            {/* 组合表现对比 */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">组合表现对比</CardTitle>
                <ArrowUpFromLine className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                {portfolioSummary.isLoading ? (
                  <TableSkeleton rows={3} cols={4} />
                ) : portfolioSummary.data && portfolioSummary.data.length > 0 ? (
                  <div className="space-y-2">
                    {portfolioSummary.data.map((p) => (
                      <div
                        key={p.id}
                        className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2 text-sm"
                      >
                        <span className="font-medium">{p.name}</span>
                        <div className="flex items-center gap-4">
                          <span className="tabular-nums">
                            {formatCurrency(p.totalAsset, 2, { thousands: amountThousands, abbreviate: amountAbbrev })}
                          </span>
                          {/* 用 `!= null` 同时排除 null 与 undefined：
                              Q-4 甲 后端已返回该字段（8 位小数比率字符串），
                              但仍可能为 null（尚无 DailyNav）或 undefined（旧后端），
                              旧写法 `!== null` 会放行 undefined 并渲染出 NaN%。 */}
                          {p.cumulativeReturnRate != null && (
                            <span
                              className={cn(
                                'tabular-nums',
                                Number(p.cumulativeReturnRate) >= 0
                                  ? 'text-up'
                                  : 'text-down',
                              )}
                            >
                              {formatPercent(p.cumulativeReturnRate, 2, { decimals: xirrDecimals })}
                            </span>
                          )}
                          {p.xirr != null && (
                            <span className="text-xs text-muted-foreground">
                              XIRR {formatPercent(p.xirr, 2, { decimals: xirrDecimals })}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="py-10 text-center text-sm text-muted-foreground">
                    暂无组合数据
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </Section>

      {/* 录入出入金弹窗 */}
      <Dialog open={cashflowOpen} onOpenChange={setCashflowOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>录入出入金</DialogTitle>
          </DialogHeader>
          <CashflowForm
            portfolioId={currentPortfolioId}
            onSuccess={() => setCashflowOpen(false)}
          />
        </DialogContent>
      </Dialog>

      {/* 录入买卖弹窗 */}
      <Dialog open={tradeOpen} onOpenChange={setTradeOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>录入买卖</DialogTitle>
          </DialogHeader>
          <SecurityTradeForm
            portfolioId={currentPortfolioId}
            onSuccess={() => setTradeOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
