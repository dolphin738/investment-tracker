/**
 * pages/transactions.tsx — 出入金管理页（PRD §7.1）
 *
 * 【A】总资产展示卡片（纯展示，不得出现输入框）：
 *   当前总资产 / 持仓市值 / 现金余额 + 近30日走势图 + 手工记录标记
 *   「[查看全部历史 →]」「[⚙ 管理历史记录 →]」均跳 /snapshots（后者带可编辑态参数）
 * 【B】现金余额（手工维护）：金额 + 生效日期 + 保存（调 cash-balance API）
 * 【C】出入金流水列表：筛选（日期范围/类型存入取出）+ 表格 + 分页
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactECharts from 'echarts-for-react';
import {
  Camera,
  ChevronRight,
  Plus,
  RotateCcw,
  Settings2,
} from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { Skeleton } from '@/components/ui/skeleton';
import { CashflowForm } from '@/features/cashflow/cashflow-form';
import { CashflowList } from '@/features/cashflow/cashflow-list';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { usePortfolios } from '@/hooks/use-portfolios';
import { useQuery } from '@tanstack/react-query';
import { getOverview } from '@/api/overview.api';
import { useLatestCashBalance, useUpsertCashBalance } from '@/hooks/use-cash-balances';
import { useNavSeries } from '@/hooks/use-query-data';
import { useSnapshots } from '@/hooks/use-snapshots';
import { toIsoDate } from '@/lib/constants';
import { ROUTE_PATH } from '@/lib/constants';
import { formatCurrency, formatDate } from '@/lib/utils';
import { QueryGranularity } from '@investment-tracker/shared';
import type { TransactionQuery } from '@/api/types';

/** 30 天前日期 YYYY-MM-DD */
function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return toIsoDate(d);
}

/** ECharts tooltip 入参（仅声明用到的字段） */
interface AxisTooltipParam {
  axisValueLabel?: string;
  seriesName?: string;
  marker?: string;
  value?: number | null;
  dataIndex: number;
}

export default function TransactionsPage(): JSX.Element {
  const navigate = useNavigate();
  const currentPortfolioId = usePortfolioStore((s) => s.currentPortfolioId);
  const { data: portfolios = [], isLoading: portfoliosLoading } = usePortfolios();
  const [open, setOpen] = useState(false);

  // ── 【A】总资产展示数据 ──
  const overview = useQuery({
    queryKey: ['overview', currentPortfolioId],
    queryFn: () => getOverview(currentPortfolioId!),
    enabled: Boolean(currentPortfolioId),
    staleTime: 30 * 1000,
  });
  const latestBalance = useLatestCashBalance(currentPortfolioId);
  const todayIso = toIsoDate(new Date());
  const start30 = daysAgoIso(30);
  const nav30 = useNavSeries(currentPortfolioId, {
    granularity: QueryGranularity.DAY,
    startDate: start30,
    endDate: todayIso,
  });
  const snapshots30 = useSnapshots(currentPortfolioId, {
    startDate: start30,
    endDate: todayIso,
    page: 1,
    pageSize: 60,
  });

  // ── 【B】现金余额维护 ──
  const [balanceAmount, setBalanceAmount] = useState('');
  const [balanceDate, setBalanceDate] = useState(toIsoDate(new Date()));
  const upsertBalanceMutation = useUpsertCashBalance();

  // ── 【C】出入金筛选 ──
  const [filterType, setFilterType] = useState<string>('all');
  const [filterStartDate, setFilterStartDate] = useState<string>('');
  const [filterEndDate, setFilterEndDate] = useState<string>('');
  const [query, setQuery] = useState<TransactionQuery>({ pageSize: 20 });

  // ── 近30日走势数据 ──
  const trendData = useMemo(() => {
    const points = nav30.data ?? [];
    return points
      .map((p) => {
        if (p.cumulativeNav === null || p.shares === null) return null;
        return {
          date: p.date,
          label: p.label,
          totalAsset: p.cumulativeNav * p.shares,
        };
      })
      .filter((v): v is { date: string; label: string; totalAsset: number } => v !== null);
  }, [nav30.data]);

  const manualDates = useMemo(() => {
    const set = new Set<string>();
    for (const s of snapshots30.data?.items ?? []) {
      if (s.source === 'MANUAL') set.add(s.date);
    }
    return set;
  }, [snapshots30.data]);

  const chartOption = useMemo(() => {
    const labels = trendData.map((d) => d.label);
    const values = trendData.map((d) => d.totalAsset);
    const manualPoints: [number, number][] = [];
    trendData.forEach((d, idx) => {
      if (manualDates.has(d.date)) manualPoints.push([idx, d.totalAsset]);
    });
    return {
      tooltip: {
        trigger: 'axis',
        formatter: (params: AxisTooltipParam | AxisTooltipParam[]): string => {
          const arr = Array.isArray(params) ? params : [params];
          const head = arr[0]?.axisValueLabel ?? '';
          const lines = arr.map((p) => {
            const v = p.value;
            const text =
              v === null || v === undefined
                ? '数据不足'
                : `¥${formatCurrency(v)}`;
            return `${p.marker ?? ''}${p.seriesName ?? ''}: ${text}`;
          });
          return [head, ...lines].join('<br/>');
        },
      },
      legend: { bottom: 0, textStyle: { fontSize: 12 } },
      grid: { left: 8, right: 16, top: 10, bottom: 28, containLabel: true },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: labels,
        axisLabel: { fontSize: 11, color: '#666' },
      },
      yAxis: {
        type: 'value',
        axisLabel: {
          fontSize: 11,
          color: '#666',
          formatter: (v: number): string => `${(v / 10000).toFixed(1)}万`,
        },
        splitLine: { show: true, lineStyle: { type: [3, 3], color: '#ccc' } },
      },
      series: [
        {
          name: '总资产',
          type: 'line',
          smooth: true,
          connectNulls: true,
          showSymbol: false,
          lineStyle: { width: 2, color: 'hsl(217, 91%, 60%)' },
          itemStyle: { color: 'hsl(217, 91%, 60%)' },
          data: values,
        },
        {
          name: '手工记录',
          type: 'scatter',
          symbolSize: 8,
          itemStyle: { color: 'hsl(0, 84%, 48%)' },
          data: manualPoints,
          tooltip: { formatter: (p: { value: [number, number] }) => `手工记录：¥${formatCurrency(p.value[1])}` },
        },
      ],
    };
  }, [trendData, manualDates]);

  const totalAsset = overview.data?.totalAsset;
  const marketValue = overview.data?.holdingsSummary?.totalMarketValue;
  const cashBalance = latestBalance.data?.amount;

  const handleSaveBalance = () => {
    const amount = Number(balanceAmount);
    if (!balanceAmount || !Number.isFinite(amount) || amount < 0) return;
    if (!balanceDate) return;
    upsertBalanceMutation.mutate(
      {
        portfolioId: currentPortfolioId!,
        payload: { asOf: balanceDate, amount },
      },
      { onSuccess: () => setBalanceAmount('') },
    );
  };

  const handleFilter = () => {
    const q: TransactionQuery = { pageSize: 20 };
    if (filterStartDate) q.startDate = filterStartDate;
    if (filterEndDate) q.endDate = filterEndDate;
    setQuery(q);
  };

  const handleResetFilter = () => {
    setFilterType('all');
    setFilterStartDate('');
    setFilterEndDate('');
    setQuery({ pageSize: 20 });
  };

  // ===== 加载态 =====
  if (portfoliosLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  // ===== 无组合 =====
  if (portfolios.length === 0) {
    return (
      <Card className="mx-auto max-w-md">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          暂无投资组合，请先在设置页创建组合
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

  return (
    <div className="space-y-6">
      {/* 页头 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">出入金</h1>
          <p className="text-sm text-muted-foreground">
            管理存入/取出现金流，系统据此计算净值与 XIRR
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          录入出入金
        </Button>
      </div>

      {/* 【A】总资产展示卡片（纯展示） */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">总资产概览</CardTitle>
            <CardDescription>纯展示 · 近 30 日走势与手工记录标记</CardDescription>
          </div>
          <div className="flex items-center gap-1 text-sm">
            <Button variant="link" size="sm" onClick={() => navigate(ROUTE_PATH.SNAPSHOTS)}>
              查看全部历史 <ChevronRight className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="link"
              size="sm"
              onClick={() => navigate(`${ROUTE_PATH.SNAPSHOTS}?manage=1`)}
            >
              <Settings2 className="mr-1 h-3.5 w-3.5" />
              管理历史记录 <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-lg bg-muted/40 p-4">
              <p className="text-xs text-muted-foreground">当前总资产</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">
                {totalAsset ? `¥${formatCurrency(totalAsset)}` : '暂无数据'}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {overview.data?.latestDate
                  ? `截至 ${overview.data.latestDate}`
                  : '数据截止日未知'}
              </p>
            </div>
            <div className="rounded-lg bg-muted/40 p-4">
              <p className="text-xs text-muted-foreground">持仓市值</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">
                {marketValue ? `¥${formatCurrency(marketValue)}` : '暂无数据'}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">由买卖流水推导</p>
            </div>
            <div className="rounded-lg bg-muted/40 p-4">
              <p className="text-xs text-muted-foreground">现金余额</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">
                {cashBalance !== undefined && cashBalance !== null
                  ? `¥${formatCurrency(cashBalance)}`
                  : '暂无数据'}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {latestBalance.data
                  ? `生效日 ${formatDate(latestBalance.data.asOf)}`
                  : '未维护，可在下方录入'}
              </p>
            </div>
          </div>

          {/* 近30日走势图 */}
          {nav30.isLoading ? (
            <Skeleton className="h-[220px] w-full" />
          ) : trendData.length === 0 ? (
            <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
              近 30 日暂无资产数据
            </div>
          ) : (
            <ReactECharts
              option={chartOption}
              style={{ height: 220, width: '100%' }}
            />
          )}
        </CardContent>
      </Card>

      {/* 【B】现金余额（手工维护） */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">现金余额（手工维护）</CardTitle>
          <CardDescription>
            维护组合现金余额，生效日起前向沿用；保存后触发净值/XIRR 重算
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="balance-amount" className="text-xs">
                金额（元）
              </Label>
              <Input
                id="balance-amount"
                type="number"
                step="0.01"
                min="0"
                className="w-[160px]"
                placeholder="0.00"
                value={balanceAmount}
                onChange={(e) => setBalanceAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="balance-date" className="text-xs">
                生效日期
              </Label>
              <Input
                id="balance-date"
                type="date"
                className="w-[160px]"
                max={toIsoDate(new Date())}
                value={balanceDate}
                onChange={(e) => setBalanceDate(e.target.value)}
              />
            </div>
            <Button
              onClick={handleSaveBalance}
              disabled={
                upsertBalanceMutation.isPending ||
                !balanceAmount ||
                Number(balanceAmount) < 0 ||
                !balanceDate
              }
            >
              <Camera className="mr-2 h-4 w-4" />
              保存
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 【C】出入金流水列表 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">出入金流水</CardTitle>
          <CardDescription>支持按日期范围与类型筛选，编辑/删除将触发重算</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 筛选栏 */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">类型</Label>
              <Select value={filterType} onValueChange={setFilterType}>
                <SelectTrigger className="w-[110px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="BUY">存入</SelectItem>
                  <SelectItem value="SELL">取出</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">起始日期</Label>
              <Input
                type="date"
                className="w-[150px]"
                value={filterStartDate}
                onChange={(e) => setFilterStartDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">截止日期</Label>
              <Input
                type="date"
                className="w-[150px]"
                value={filterEndDate}
                onChange={(e) => setFilterEndDate(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleFilter}>
                筛选
              </Button>
              <Button size="sm" variant="outline" onClick={handleResetFilter}>
                <RotateCcw className="mr-1 h-3.5 w-3.5" />
                重置
              </Button>
            </div>
          </div>

          <CashflowList
            portfolioId={currentPortfolioId}
            query={query}
            typeFilter={filterType}
          />
        </CardContent>
      </Card>

      {/* 录入/编辑出入金弹窗 */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>录入出入金</DialogTitle>
          </DialogHeader>
          <CashflowForm
            portfolioId={currentPortfolioId}
            onSuccess={() => setOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
