/**
 * pages/dashboard.tsx — 概览页（PRD §7.4）
 *
 * - 6 指标卡片：当前总资产 / 累计收益率 / 当年收益率 / 年化XIRR / 累计净值 / 净投入
 * - 维度切换 [日][周][月][年] + 范围下拉（近1月/3月/1年/全部）
 * - 四宫格：净值趋势（累计+当年双线）/ XIRR 趋势 / 近期出入金最近5笔 / 组合表现对比
 * - 按钮「+录入出入金」「+录入买卖」→ 分别打开出入金/买卖弹窗
 */

import { useMemo, useState } from 'react';
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
import { usePortfolioStore } from '@/stores/portfolio.store';
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
import {
  formatPercent,
  formatDecimal,
  formatCurrency,
  formatDate,
  cn,
} from '@/lib/utils';
import { toIsoDate } from '@/lib/constants';
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

/** 快捷日期范围（PRD §7.4：近1月/3月/1年/全部） */
const DATE_RANGE_OPTIONS = [
  { value: '1m', label: '近1月' },
  { value: '3m', label: '近3月' },
  { value: '1y', label: '近1年' },
  { value: 'all', label: '全部' },
] as const;

/** 根据快捷项计算起止日期 */
function resolveDateRange(range: string): { startDate: string; endDate: string } {
  const end = new Date();
  const endStr = toIsoDate(end);
  const start = new Date();
  switch (range) {
    case '1m':
      start.setMonth(start.getMonth() - 1);
      break;
    case '3m':
      start.setMonth(start.getMonth() - 3);
      break;
    case '1y':
      start.setFullYear(start.getFullYear() - 1);
      break;
    case 'all':
      start.setFullYear(2000, 0, 1);
      break;
    default:
      start.setFullYear(start.getFullYear() - 1);
  }
  return { startDate: toIsoDate(start), endDate: endStr };
}

/** 出入金类型中文映射（BUY=存入，SELL=取出） */
const TYPE_LABEL: Record<string, string> = {
  BUY: '存入',
  SELL: '取出',
};

export default function DashboardPage(): JSX.Element {
  const currentPortfolioId = usePortfolioStore((s) => s.currentPortfolioId);
  const { data: portfolios = [], isLoading: portfoliosLoading } = usePortfolios();

  // 录入弹窗状态
  const [cashflowOpen, setCashflowOpen] = useState(false);
  const [tradeOpen, setTradeOpen] = useState(false);

  // 维度状态
  const [granularity, setGranularity] = useState<string>('month');
  const [dateRange, setDateRange] = useState<string>('1y');
  const { startDate, endDate } = useMemo(
    () => resolveDateRange(dateRange),
    [dateRange],
  );

  // 概览聚合数据
  const overview = useQuery({
    queryKey: ['overview', currentPortfolioId],
    queryFn: () => getOverview(currentPortfolioId!),
    enabled: Boolean(currentPortfolioId),
    staleTime: 30 * 1000,
  });

  // 净值/XIRR 序列（接入维度）
  const xirrSeries = useXirrSeries(currentPortfolioId, {
    granularity: granularity as QueryGranularity,
    startDate,
    endDate,
    aggregation: AggregationMethod.LAST,
  });
  const navSeries = useNavSeries(currentPortfolioId, {
    granularity: granularity as QueryGranularity,
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
    cumulativeNav !== null ? cumulativeNav - 1 : null
  );
  const yearReturnRate = ov?.yearReturnRate ?? (
    yearNav !== null ? yearNav - 1 : null
  );

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

      {/* ===== 6 指标卡片 ===== */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          title="当前总资产"
          value={totalAsset ? `¥${formatCurrency(totalAsset)}` : '暂无数据'}
          description={ov?.latestDate ? `截至 ${ov.latestDate}` : undefined}
          trend="neutral"
        />
        <StatCard
          title="累计收益率"
          value={formatPercent(totalReturnRate)}
          description={cumulativeNav ? `净值 ${formatDecimal(cumulativeNav)}` : '暂无数据'}
          trend={
            totalReturnRate !== null
              ? totalReturnRate >= 0
                ? 'up'
                : 'down'
              : 'neutral'
          }
        />
        <StatCard
          title="当年收益率"
          value={formatPercent(yearReturnRate)}
          description={yearNav ? `净值 ${formatDecimal(yearNav)}` : '暂无数据'}
          trend={
            yearReturnRate !== null
              ? yearReturnRate >= 0
                ? 'up'
                : 'down'
              : 'neutral'
          }
        />
        <StatCard
          title="年化 XIRR"
          value={formatPercent(cumulativeXirr)}
          description="累计年化"
          trend={
            cumulativeXirr !== null
              ? cumulativeXirr >= 0
                ? 'up'
                : 'down'
              : 'neutral'
          }
        />
        <StatCard
          title="累计净值"
          value={cumulativeNav !== null ? formatDecimal(cumulativeNav) : '暂无数据'}
          description="单位净值"
          trend={
            cumulativeNav !== null
              ? cumulativeNav >= 1
                ? 'up'
                : 'down'
              : 'neutral'
          }
        />
        <StatCard
          title="净投入"
          value={netInvested ? `¥${formatCurrency(netInvested)}` : '暂无数据'}
          description="存入 - 取出"
          trend="neutral"
        />
      </div>

      {/* ===== 维度切换 + 范围下拉 ===== */}
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={granularity} onValueChange={setGranularity} className="w-auto">
          <TabsList>
            {GRANULARITY_TABS.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Select value={dateRange} onValueChange={setDateRange}>
          <SelectTrigger className="w-[120px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DATE_RANGE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* ===== 四宫格 ===== */}
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
            <ArrowLeftRight className="h-4 w-4 text-muted-foreground" />
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
                        {tx.type === CashFlowType.BUY ? '+' : '-'}¥
                        {formatCurrency(tx.amount)}
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
                        ¥{formatCurrency(p.totalAsset)}
                      </span>
                      {p.cumulativeReturnRate !== null && (
                        <span
                          className={cn(
                            'tabular-nums',
                            p.cumulativeReturnRate >= 0
                              ? 'text-up'
                              : 'text-down',
                          )}
                        >
                          {formatPercent(p.cumulativeReturnRate)}
                        </span>
                      )}
                      {p.xirr !== null && (
                        <span className="text-xs text-muted-foreground">
                          XIRR {formatPercent(p.xirr)}
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
