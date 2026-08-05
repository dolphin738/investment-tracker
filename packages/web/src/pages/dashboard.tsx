/**
 * pages/dashboard.tsx — 概览页（PRD §7.4）
 *
 * - 6 指标卡片：当前总资产 / 累计收益率 / 当年收益率 / 年化XIRR / 累计净值 / 净投入
 * - 维度切换 [日][周][月][年] + 范围下拉（共享 7 项快捷范围，DASH-P0-02 / 决策 Q-6 乙）
 * - 四宫格：净值趋势（累计+当年双线）/ XIRR 趋势 / 近期出入金最近5笔（带「查看全部」，
 *   DASH-P0-05）/ 组合表现对比
 * - 有组合但无数据时，四宫格位置渲染三步引导卡（DASH-P0-06）
 * - 按钮「+录入出入金」「+录入买卖」→ 分别打开出入金/买卖弹窗
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { StatCard } from '@/components/charts/stat-card';
import { XirrTrendChart } from '@/components/charts/xirr-trend-chart';
import { NavTrendChart } from '@/components/charts/nav-trend-chart';
import { TableSkeleton } from '@/components/LoadingSpinner';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { CashflowForm } from '@/features/cashflow/cashflow-form';
import { SecurityTradeForm } from '@/features/security-trade/security-trade-form';
import { FreshnessBanner } from '@/features/overview/freshness-banner';
import { createOverviewSchema } from '@/features/overview/overview-query-params';
import type { OverviewQueryState } from '@/features/overview/overview-query-params';
import {
  QUICK_RANGE_OPTIONS,
  resolveQuickRange,
} from '@/features/query/dimension-switcher';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { usePreferenceStore } from '@/stores/preference.store';
import { usePortfolios } from '@/hooks/use-portfolios';
import {
  useLatestXirr,
  useLatestNav,
  useXirrSeries,
  useNavSeries,
} from '@/hooks/use-query-data';
import { useQuery } from '@tanstack/react-query';
import { getOverview, getPortfoliosSummary } from '@/api/overview.api';
import { listTransactions } from '@/api/transaction.api';
import { CashFlowType } from '@investment-tracker/shared';
import { useUrlState } from '@/lib/url-query';
import {
  formatPercent,
  formatDecimal,
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
 * 渲染在四宫格位置，6 指标卡与维度切换器仍正常展示。
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
    return resolveQuickRange(overviewQuery.range);
  }, [overviewQuery.range, overviewQuery.from, overviewQuery.to]);

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
   * DASH-P0-06：「有组合但无数据」判定。
   * 走到这里 portfolios.length > 0 已由上方早退分支保证；
   * overview 加载完成（非 isLoading）且无返回数据，即视为该组合尚未录入任何数据，
   * 此时用三步引导卡替换四宫格（6 指标卡与维度切换器仍正常渲染）。
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
    <div className="space-y-6">
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

      {/* ===== 数据新鲜度提示条（DASH-P1-03 · 后端判定，isStale=false 不渲染） ===== */}
      {ov?.freshness && (
        <FreshnessBanner
          portfolioId={currentPortfolioId}
          freshness={ov.freshness}
        />
      )}

      {/* ===== 6 指标卡片 ===== */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          title="当前总资产"
          value={totalAsset ? formatCurrency(totalAsset, 2, { thousands: amountThousands, abbreviate: amountAbbrev }) : '暂无数据'}
          description={ov?.latestDate ? `截至 ${ov.latestDate}` : undefined}
          trend="neutral"
        />
        <StatCard
          title="累计收益率"
          value={formatPercent(totalReturnRate, 2, { decimals: xirrDecimals })}
          description={cumulativeNav ? `净值 ${formatDecimal(cumulativeNav, navDecimals)}` : '暂无数据'}
          trend={
            totalReturnRate !== null
              ? Number(totalReturnRate) >= 0
                ? 'up'
                : 'down'
              : 'neutral'
          }
        />
        <StatCard
          title="当年收益率"
          value={formatPercent(yearReturnRate, 2, { decimals: xirrDecimals })}
          description={yearNav ? `净值 ${formatDecimal(yearNav, navDecimals)}` : '暂无数据'}
          trend={
            yearReturnRate !== null
              ? Number(yearReturnRate) >= 0
                ? 'up'
                : 'down'
              : 'neutral'
          }
        />
        <StatCard
          title="年化 XIRR"
          value={formatPercent(cumulativeXirr, 2, { decimals: xirrDecimals })}
          description="累计年化"
          trend={
            cumulativeXirr !== null
              ? Number(cumulativeXirr) >= 0
                ? 'up'
                : 'down'
              : 'neutral'
          }
        />
        <StatCard
          title="累计净值"
          value={cumulativeNav !== null ? formatDecimal(cumulativeNav, navDecimals) : '暂无数据'}
          description="单位净值"
          trend={
            cumulativeNav !== null
              ? Number(cumulativeNav) >= 1
                ? 'up'
                : 'down'
              : 'neutral'
          }
        />
        <StatCard
          title="净投入"
          value={netInvested ? formatCurrency(netInvested, 2, { thousands: amountThousands, abbreviate: amountAbbrev }) : '暂无数据'}
          description="存入 - 取出"
          trend="neutral"
        />
      </div>

      {/* ===== 维度切换 + 范围下拉 ===== */}
      <div className="flex flex-wrap items-center gap-3">
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
        <Select
          value={overviewQuery.range}
          onValueChange={(v) =>
            setOverviewQuery({ range: v as OverviewQueryState['range'] })
          }
        >
          <SelectTrigger className="w-[120px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {QUICK_RANGE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* ===== 有组合但无数据：三步引导（DASH-P0-06） ===== */}
      {hasNoData && (
        <OnboardingGuide
          onOpenCashflow={() => setCashflowOpen(true)}
          onOpenTrade={() => setTradeOpen(true)}
        />
      )}

      {/* ===== 四宫格（仅在有数据时渲染） ===== */}
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
