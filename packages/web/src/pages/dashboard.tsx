/**
 * pages/dashboard.tsx — Dashboard 首页
 *
 * 布局：
 * - 4 个指标卡片（累计 XIRR / 总收益率 / 当年收益率 / 最大回撤）
 * - 净值趋势图（双线：累计 + 当年）
 * - XIRR 趋势图
 * - 录入入口（快捷按钮：录入交易 / 录入快照）
 *
 * 数据来源：
 * - useLatestXirr + useLatestNav：构造 4 卡片
 * - useNavSeries（按月聚合，近 1 年）：净值趋势图
 * - useXirrSeries（按月聚合，近 1 年）：XIRR 趋势图
 */

import { useNavigate } from 'react-router-dom';
import { Plus, Camera, ArrowLeftRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatCard } from '@/components/charts/stat-card';
import { XirrTrendChart } from '@/components/charts/xirr-trend-chart';
import { NavTrendChart } from '@/components/charts/nav-trend-chart';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { usePortfolios } from '@/hooks/use-portfolios';
import { useLatestXirr, useLatestNav, useXirrSeries, useNavSeries } from '@/hooks/use-query-data';
import { formatPercent, formatDecimal } from '@/lib/utils';
import { getDefaultDateRange, ROUTE_PATH } from '@/lib/constants';
import { QueryGranularity, AggregationMethod } from '@investment-tracker/shared';

export default function DashboardPage(): JSX.Element {
  const navigate = useNavigate();
  const currentPortfolioId = usePortfolioStore((s) => s.currentPortfolioId);
  const { data: portfolios = [] } = usePortfolios();
  const { startDate, endDate } = getDefaultDateRange();

  const latestXirr = useLatestXirr(currentPortfolioId);
  const latestNav = useLatestNav(currentPortfolioId);
  const xirrSeries = useXirrSeries(currentPortfolioId, {
    granularity: QueryGranularity.MONTH,
    startDate,
    endDate,
    aggregation: AggregationMethod.LAST,
  });
  const navSeries = useNavSeries(currentPortfolioId, {
    granularity: QueryGranularity.MONTH,
    startDate,
    endDate,
    aggregation: AggregationMethod.LAST,
  });

  // 没有组合时引导创建
  if (portfolios.length === 0) {
    return (
      <Card className="mx-auto max-w-md">
        <CardHeader>
          <CardTitle>欢迎，先创建您的第一个投资组合</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            点击顶部"组合选择"下拉中的"新建组合"开始使用系统。
          </p>
          <Button onClick={() => navigate(ROUTE_PATH.SETTINGS)}>
            前往设置管理组合
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!currentPortfolioId) {
    return (
      <Card className="mx-auto max-w-md">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          请先在顶部选择一个投资组合
        </CardContent>
      </Card>
    );
  }

  const cumulativeXirr = latestXirr.data?.xirrValue ?? null;
  const latestCumulativeNav = latestNav.data?.cumulativeNav ?? null;
  const latestYearNav = latestNav.data?.yearNav ?? null;
  const totalReturnRate =
    latestCumulativeNav !== null ? latestCumulativeNav - 1 : null;
  const yearReturnRate = latestYearNav !== null ? latestYearNav - 1 : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            最近 12 个月收益概览
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => navigate(ROUTE_PATH.TRANSACTIONS)} variant="outline">
            <ArrowLeftRight className="mr-2 h-4 w-4" />
            录入交易
          </Button>
          <Button onClick={() => navigate(ROUTE_PATH.SNAPSHOTS)}>
            <Camera className="mr-2 h-4 w-4" />
            录入快照
          </Button>
        </div>
      </div>

      {/* 指标卡片 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="累计 XIRR"
          value={formatPercent(cumulativeXirr)}
          description={latestXirr.data ? `截至 ${latestXirr.data.date}` : '暂无数据'}
          trend={
            cumulativeXirr !== null
              ? cumulativeXirr >= 0
                ? 'up'
                : 'down'
              : 'neutral'
          }
        />
        <StatCard
          title="总收益率"
          value={formatPercent(totalReturnRate)}
          description={latestNav.data ? `截至 ${latestNav.data.date}` : '暂无数据'}
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
          description={
            latestYearNav !== null ? `当年净值 ${formatDecimal(latestYearNav)}` : '暂无数据'
          }
          trend={
            yearReturnRate !== null
              ? yearReturnRate >= 0
                ? 'up'
                : 'down'
              : 'neutral'
          }
        />
        <StatCard
          title="最大回撤"
          value="-"
          description="P1 阶段开放"
          trend="neutral"
        />
      </div>

      {/* 趋势图 */}
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

      {/* 快捷录入入口 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">快捷操作</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button onClick={() => navigate(ROUTE_PATH.TRANSACTIONS)} variant="outline">
            <Plus className="mr-2 h-4 w-4" />
            录入交易
          </Button>
          <Button onClick={() => navigate(ROUTE_PATH.SNAPSHOTS)} variant="outline">
            <Plus className="mr-2 h-4 w-4" />
            录入资产快照
          </Button>
          <Button onClick={() => navigate(ROUTE_PATH.XIRR_ANALYSIS)} variant="outline">
            查看 XIRR 分析
          </Button>
          <Button onClick={() => navigate(ROUTE_PATH.NAV_ANALYSIS)} variant="outline">
            查看净值分析
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
