/**
 * pages/HoldingsPage.tsx — 持仓页（方案B · 只读）
 *
 * 方案B：持仓不落库，由后端按 SecurityTrade（买卖流水）实时推导。
 * 本页只读展示：
 * - 持仓列表（表格）：标的名称/代码、类型、数量、成本价、现价、市值、盈亏、盈亏%、占比
 * - 顶部汇总行：总市值、总成本、总盈亏、总盈亏率、标的数
 * - 日期选择（推导目标日期）+ 类型筛选（前端过滤）
 * - 暂无持仓时引导用户前往「交易管理」页录入买卖流水（SecurityTrade 是持仓唯一来源）
 * - 加载态 / 空态 / 错误态
 *
 * 方案A 的新增/编辑/删除持仓、同步快照、日期下拉均已移除（对应后端端点已删除）。
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PackageOpen, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { TableSkeleton } from '@/components/LoadingSpinner';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { usePortfolios } from '@/hooks/use-portfolios';
import { useHoldings } from '@/hooks/use-holdings';
import { useSecurities } from '@/hooks/use-securities';
import { formatCurrency, formatPercent, cn } from '@/lib/utils';
import { ROUTE_PATH } from '@/lib/constants';

// ===== 常量 =====
const SECURITY_TYPE_LABEL: Record<string, string> = {
  STOCK: '股票',
  FUND: '基金',
  BOND: '债券',
  CASH: '现金',
  OTHER: '其他',
};

/** 当前日期 YYYY-MM-DD（本地时区） */
function todayIso(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export default function HoldingsPage(): JSX.Element {
  const navigate = useNavigate();
  const currentPortfolioId = usePortfolioStore((s) => s.currentPortfolioId);
  const { data: portfolios = [], isLoading: portfoliosLoading } = usePortfolios();

  // 筛选状态
  const [selectedDate, setSelectedDate] = useState<string>(todayIso());
  const [typeFilter, setTypeFilter] = useState<string>('ALL');

  // 数据查询
  const holdings = useHoldings(currentPortfolioId, { date: selectedDate });
  const securities = useSecurities(currentPortfolioId);

  // ===== 加载态 =====
  if (portfoliosLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="持仓" />
        <TableSkeleton rows={5} cols={7} />
      </div>
    );
  }

  // ===== 无组合 =====
  if (portfolios.length === 0) {
    return (
      <EmptyState
        title="暂无投资组合"
        description="创建组合后即可查看持仓"
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

  const allItems = holdings.data?.items ?? [];
  const aggregate = holdings.data?.aggregate;
  const items =
    typeFilter === 'ALL'
      ? allItems
      : allItems.filter((h) => h.securityType === typeFilter);
  const securityList = securities.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="持仓"
        description="持仓由证券买卖流水实时推导，只读展示"
        actions={
          <Button variant="outline" size="sm" onClick={() => navigate(ROUTE_PATH.TRANSACTIONS)}>
            前往交易管理录入流水
          </Button>
        }
      />

      {/* 日期选择 + 类型筛选 */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Label className="text-sm">日期</Label>
          <Input
            type="date"
            className="w-40"
            value={selectedDate}
            max={todayIso()}
            onChange={(e) => setSelectedDate(e.target.value)}
          />
        </div>
        <Tabs value={typeFilter} onValueChange={setTypeFilter}>
          <TabsList>
            <TabsTrigger value="ALL">全部</TabsTrigger>
            {Object.entries(SECURITY_TYPE_LABEL).map(([k, v]) => (
              <TabsTrigger key={k} value={k}>
                {v}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {/* ===== 错误态 ===== */}
      {holdings.isError && (
        <Card className="border-destructive/50">
          <CardContent className="flex flex-col items-center gap-4 py-8">
            <AlertTriangle className="h-8 w-8 text-destructive" />
            <p className="text-sm text-destructive">数据加载失败</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => holdings.refetch()}
            >
              重新加载
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ===== 加载态 ===== */}
      {holdings.isLoading && <TableSkeleton rows={5} cols={8} />}

      {/* ===== 空态 ===== */}
      {!holdings.isLoading &&
        !holdings.isError &&
        items.length === 0 && (
          <EmptyState
            icon={<PackageOpen className="h-12 w-12" />}
            title="暂无持仓数据"
            description={
              securityList.length === 0
                ? '请先在交易管理页新建标的，再录入买卖流水'
                : '持仓由证券买卖流水实时推导，请前往交易管理页录入买卖流水'
            }
            action={
              <Button onClick={() => navigate(ROUTE_PATH.TRANSACTIONS)}>
                前往交易管理录入流水
              </Button>
            }
          />
        )}

      {/* ===== 数据态 ===== */}
      {!holdings.isLoading && !holdings.isError && items.length > 0 && (
        <>
          {/* 汇总条 */}
          {aggregate && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <Card>
                <CardContent className="py-3">
                  <p className="text-xs text-muted-foreground">总市值</p>
                  <p className="text-lg font-bold tabular-nums">
                    ¥{formatCurrency(aggregate.totalMarketValue)}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-3">
                  <p className="text-xs text-muted-foreground">总成本</p>
                  <p className="text-lg font-bold tabular-nums">
                    ¥{formatCurrency(aggregate.totalCost)}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-3">
                  <p className="text-xs text-muted-foreground">总浮动盈亏</p>
                  <p
                    className={cn(
                      'text-lg font-bold tabular-nums',
                      aggregate.totalProfit >= 0
                        ? 'text-red-600'
                        : 'text-emerald-600',
                    )}
                  >
                    {aggregate.totalProfit >= 0 ? '+' : ''}
                    ¥{formatCurrency(aggregate.totalProfit)}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-3">
                  <p className="text-xs text-muted-foreground">总盈亏率</p>
                  <p
                    className={cn(
                      'text-lg font-bold tabular-nums',
                      aggregate.totalProfitRate >= 0
                        ? 'text-red-600'
                        : 'text-emerald-600',
                    )}
                  >
                    {formatPercent(aggregate.totalProfitRate)}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-3">
                  <p className="text-xs text-muted-foreground">标的数</p>
                  <p className="text-lg font-bold tabular-nums">
                    {aggregate.securityCount}
                  </p>
                </CardContent>
              </Card>
            </div>
          )}

          {/* 持仓表格 */}
          <Card>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>标的</TableHead>
                    <TableHead>代码</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead className="text-right">数量</TableHead>
                    <TableHead className="text-right">成本价</TableHead>
                    <TableHead className="text-right">现价</TableHead>
                    <TableHead className="text-right">市值</TableHead>
                    <TableHead className="text-right">盈亏</TableHead>
                    <TableHead className="text-right">盈亏%</TableHead>
                    <TableHead className="text-right">占比</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((h) => {
                    const weight =
                      aggregate && aggregate.totalMarketValue > 0
                        ? h.marketValue / aggregate.totalMarketValue
                        : 0;
                    return (
                      <TableRow key={h.securityId}>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2">
                            {h.securityName}
                            {h.flag === 'COST_BASED' && (
                              <Badge
                                variant="outline"
                                className="text-[10px] text-muted-foreground"
                                title="无现价记录，按成本价估值"
                              >
                                成本估值
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {h.securityCode}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="text-xs">
                            {SECURITY_TYPE_LABEL[h.securityType] ||
                              h.securityType}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatCurrency(h.quantity, 2)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          ¥{formatCurrency(h.avgCost)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          ¥{formatCurrency(h.marketPrice)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          ¥{formatCurrency(h.marketValue)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'text-right tabular-nums',
                            h.pnl >= 0 ? 'text-red-600' : 'text-emerald-600',
                          )}
                        >
                          {h.pnl >= 0 ? '+' : ''}
                          ¥{formatCurrency(Math.abs(h.pnl))}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'text-right tabular-nums',
                            h.pnlRate >= 0
                              ? 'text-red-600'
                              : 'text-emerald-600',
                          )}
                        >
                          {formatPercent(h.pnlRate)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatPercent(weight)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
