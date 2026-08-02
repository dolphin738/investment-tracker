/**
 * pages/dashboard.tsx — 概览页（Dashboard 增强 v2）
 *
 * 布局：
 * - 6 个指标卡片：当前总资产 / 累计收益率 / 当年收益率 / 年化 XIRR / 累计净值 / 净投入本金
 * - 时间维度切换器（日/周/月/年 + 日期范围）
 * - 净值趋势图 + XIRR 趋势图（接入维度参数）
 * - 近期交易列表（最新 5 条）
 *
 * 数据来源：
 * - GET /api/portfolios/:id/overview — 6 卡片数据
 * - 现有 query API — 净值/XIRR 序列
 * - GET /api/portfolios/:id/transactions — 近期交易
 */

import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, ArrowLeftRight, Camera } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StatCard } from '@/components/charts/stat-card';
import { XirrTrendChart } from '@/components/charts/xirr-trend-chart';
import { NavTrendChart } from '@/components/charts/nav-trend-chart';
import { LoadingSpinner, PageSkeleton, TableSkeleton } from '@/components/LoadingSpinner';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { usePortfolios } from '@/hooks/use-portfolios';
import {
  useLatestXirr,
  useLatestNav,
  useXirrSeries,
  useNavSeries,
} from '@/hooks/use-query-data';
import { useQuery } from '@tanstack/react-query';
import { getOverview } from '@/api/overview.api';
import { listTransactions } from '@/api/transaction.api';
import { TransactionType } from '@investment-tracker/shared';
import {
  formatPercent,
  formatDecimal,
  formatCurrency,
  formatDate,
} from '@/lib/utils';
import { getDefaultDateRange, ROUTE_PATH } from '@/lib/constants';
import {
  QueryGranularity,
  AggregationMethod,
} from '@investment-tracker/shared';
import { cn } from '@/lib/utils';

/** 维度选项 */
const GRANULARITY_TABS = [
  { value: 'day', label: '日' },
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
  { value: 'year', label: '年' },
] as const;

/** 快捷日期范围 */
const DATE_RANGE_OPTIONS = [
  { value: '3m', label: '近 3 月' },
  { value: '1y', label: '近 1 年' },
  { value: 'ytd', label: '今年' },
  { value: 'all', label: '全部' },
] as const;

/** 根据快捷项计算起止日期 */
function resolveDateRange(
  range: string,
): { startDate: string; endDate: string } {
  const end = new Date();
  const endStr = end.toISOString().slice(0, 10);
  const start = new Date();

  switch (range) {
    case '3m':
      start.setMonth(start.getMonth() - 3);
      break;
    case '1y':
      start.setFullYear(start.getFullYear() - 1);
      break;
    case 'ytd':
      start.setMonth(0, 1);
      break;
    case 'all':
      start.setFullYear(2000, 0, 1);
      break;
    default:
      start.setFullYear(start.getFullYear() - 1);
  }
  return { startDate: start.toISOString().slice(0, 10), endDate: endStr };
}

/** 交易类型中文映射 */
const TYPE_LABEL: Record<string, string> = {
  BUY: '存入',
  SELL: '取出',
};

export default function DashboardPage(): JSX.Element {
  const navigate = useNavigate();
  const currentPortfolioId = usePortfolioStore((s) => s.currentPortfolioId);
  const { data: portfolios = [], isLoading: portfoliosLoading } = usePortfolios();

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

  // 最新净值/XIRR（保留兼容）
  const latestXirr = useLatestXirr(currentPortfolioId);
  const latestNav = useLatestNav(currentPortfolioId);

  // 近期交易（最新 5 条）
  const recentTransactions = useQuery({
    queryKey: ['transactions', 'recent', currentPortfolioId],
    queryFn: () =>
      listTransactions(currentPortfolioId!, { page: 1, pageSize: 5 }),
    enabled: Boolean(currentPortfolioId),
    staleTime: 30 * 1000,
  });

  // ===== 加载态 =====
  if (portfoliosLoading) {
    return <PageSkeleton />;
  }

  // ===== 无组合 =====
  if (portfolios.length === 0) {
    return (
      <EmptyState
        title="欢迎，先创建您的第一个投资组合"
        description="创建组合后即可开始录入交易和快照数据。"
        action={
          <Button onClick={() => navigate(ROUTE_PATH.SETTINGS)}>
            前往设置管理组合
          </Button>
        }
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

  // ===== 有组合无数据 =====
  const hasData = overview.data && overview.data.latestDate;

  // 概览数据
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

  // 概览加载中
  if (overview.isLoading && latestNav.isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="概览" description="加载中…" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="space-y-3 p-6">
              <div className="h-4 w-24 animate-pulse rounded bg-muted" />
              <div className="h-8 w-32 animate-pulse rounded bg-muted" />
              <div className="h-3 w-20 animate-pulse rounded bg-muted" />
            </Card>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="h-80 animate-pulse rounded-lg bg-muted" />
          <div className="h-80 animate-pulse rounded-lg bg-muted" />
        </div>
      </div>
    );
  }

  // 概览错误态
  if (overview.isError && latestNav.isError) {
    return (
      <div className="space-y-6">
        <PageHeader title="概览" />
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12">
            <p className="text-sm text-destructive">
              数据加载失败，请稍后重试
            </p>
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
          ov?.latestDate
            ? `数据截止 ${ov.latestDate}`
            : '最近 12 个月收益概览'
        }
        actions={
          <div className="flex gap-2">
            <Button
              onClick={() => navigate(ROUTE_PATH.TRANSACTIONS)}
              variant="outline"
              size="sm"
            >
              <ArrowLeftRight className="mr-2 h-4 w-4" />
              录入交易
            </Button>
            <Button
              onClick={() => navigate(ROUTE_PATH.SNAPSHOTS)}
              size="sm"
            >
              <Camera className="mr-2 h-4 w-4" />
              录入快照
            </Button>
          </div>
        }
      />

      {/* ===== 6 卡片 ===== */}
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
          title="净投入本金"
          value={netInvested ? `¥${formatCurrency(netInvested)}` : '暂无数据'}
          description="存入 - 取出"
          trend="neutral"
        />
      </div>

      {/* ===== 维度切换 ===== */}
      <div className="flex flex-wrap items-center gap-3">
        <Tabs
          value={granularity}
          onValueChange={setGranularity}
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
        <Tabs
          value={dateRange}
          onValueChange={setDateRange}
          className="w-auto"
        >
          <TabsList className="border bg-transparent">
            {DATE_RANGE_OPTIONS.map((opt) => (
              <TabsTrigger key={opt.value} value={opt.value} className="data-[state=active]:bg-muted">
                {opt.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {/* ===== 趋势图 ===== */}
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
        />
      </div>

      {/* ===== 近期交易 + 快捷操作 ===== */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 近期交易 */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">近期交易</CardTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate(ROUTE_PATH.TRANSACTIONS)}
            >
              查看全部
            </Button>
          </CardHeader>
          <CardContent>
            {recentTransactions.isLoading ? (
              <TableSkeleton rows={3} cols={4} />
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
                          tx.type === TransactionType.BUY
                            ? 'text-emerald-600'
                            : 'text-red-600',
                        )}
                      >
                        {TYPE_LABEL[tx.type] || tx.type}
                      </span>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="text-sm font-medium tabular-nums">
                        ¥{formatCurrency(tx.amount)}
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
                title="还没有交易记录"
                description="录入第一笔交易开始跟踪收益"
                action={
                  <Button
                    size="sm"
                    onClick={() => navigate(ROUTE_PATH.TRANSACTIONS)}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    录入交易
                  </Button>
                }
              />
            )}
          </CardContent>
        </Card>

        {/* 快捷操作 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">快捷操作</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button
              onClick={() => navigate(ROUTE_PATH.TRANSACTIONS)}
              variant="outline"
            >
              <Plus className="mr-2 h-4 w-4" />
              录入交易
            </Button>
            <Button
              onClick={() => navigate(ROUTE_PATH.SNAPSHOTS)}
              variant="outline"
            >
              <Plus className="mr-2 h-4 w-4" />
              录入资产快照
            </Button>
            <Button
              onClick={() => navigate(ROUTE_PATH.XIRR_ANALYSIS)}
              variant="outline"
            >
              查看 XIRR 分析
            </Button>
            <Button
              onClick={() => navigate(ROUTE_PATH.NAV_ANALYSIS)}
              variant="outline"
            >
              查看净值分析
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
