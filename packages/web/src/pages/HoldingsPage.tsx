/**
 * pages/HoldingsPage.tsx — 持仓页（PRD §7.2 · 方案B 只读推导）
 *
 * - 标题「+ 录入买卖」按钮 → 打开证券买卖录入弹窗（不是跳出入金页！）
 * - 【A】持仓汇总：总市值 / 总成本 / 浮盈 / 标的数
 * - 【B】持仓列表（只读，由 security-trades 推导）：
 *   标的/代码/类型/数量/成本价/现价/市值/占比，现价支持内联编辑（调 security-price API）
 * - 【C】证券买卖明细流水：列表 + 筛选（标的/日期/方向）+ 编辑/删除
 * - 空态引导按钮 → 打开录入弹窗（与出入金页完全解耦）
 */

import { useState } from 'react';
import { PackageOpen, Plus, AlertTriangle } from 'lucide-react';
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
import { TableSkeleton } from '@/components/LoadingSpinner';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { SecurityTradeForm } from '@/features/security-trade/security-trade-form';
import { SecurityTradeList } from '@/features/security-trade/security-trade-list';
import { InlinePriceEditor } from '@/features/security-price/inline-price-editor';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { usePortfolios } from '@/hooks/use-portfolios';
import { useHoldings } from '@/hooks/use-holdings';
import { useSecurities } from '@/hooks/use-securities';
import { toIsoDate } from '@/lib/constants';
import { formatCurrency, formatPercent, cn } from '@/lib/utils';

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
  const currentPortfolioId = usePortfolioStore((s) => s.currentPortfolioId);
  const { data: portfolios = [], isLoading: portfoliosLoading } = usePortfolios();

  // 录入买卖弹窗
  const [tradeDialogOpen, setTradeDialogOpen] = useState(false);
  // 买卖明细筛选
  const [filterSecurityId, setFilterSecurityId] = useState<string>('all');
  const [filterStartDate, setFilterStartDate] = useState<string>('');
  const [filterEndDate, setFilterEndDate] = useState<string>('');
  const [filterSide, setFilterSide] = useState<string>('all');
  const [tradeQuery, setTradeQuery] = useState<{
    securityId?: string;
    startDate?: string;
    endDate?: string;
  }>({});

  const holdings = useHoldings(currentPortfolioId, { date: todayIso() });
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
        description="创建组合后即可录入买卖并查看持仓"
        action={
          <Button onClick={() => setTradeDialogOpen(false)} disabled>
            请先在设置页创建组合
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

  const items = holdings.data?.items ?? [];
  const aggregate = holdings.data?.aggregate;
  const securityList = securities.data ?? [];

  const handleApplyTradeFilter = () => {
    const q: { securityId?: string; startDate?: string; endDate?: string } = {};
    if (filterSecurityId !== 'all') q.securityId = filterSecurityId;
    if (filterStartDate) q.startDate = filterStartDate;
    if (filterEndDate) q.endDate = filterEndDate;
    setTradeQuery(q);
  };

  const handleResetTradeFilter = () => {
    setFilterSecurityId('all');
    setFilterStartDate('');
    setFilterEndDate('');
    setFilterSide('all');
    setTradeQuery({});
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="持仓"
        description="持仓由证券买卖流水实时推导，只读展示；现价可内联修改"
        actions={
          <Button size="sm" onClick={() => setTradeDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            录入买卖
          </Button>
        }
      />

      <Tabs defaultValue="holdings">
        <TabsList>
          <TabsTrigger value="holdings">持仓</TabsTrigger>
          <TabsTrigger value="trades">买卖明细</TabsTrigger>
        </TabsList>

        {/* ============ 持仓 Tab ============ */}
        <div className="mt-4 space-y-6">
          {/* 【A】汇总 */}
          {aggregate && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
                  <p className="text-xs text-muted-foreground">浮盈</p>
                  <p
                    className={cn(
                      'text-lg font-bold tabular-nums',
                      aggregate.totalProfit >= 0 ? 'text-up' : 'text-down',
                    )}
                  >
                    {aggregate.totalProfit >= 0 ? '+' : ''}
                    ¥{formatCurrency(aggregate.totalProfit)}
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

          {/* 【B】持仓列表 */}
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

          {holdings.isLoading && <TableSkeleton rows={5} cols={8} />}

          {!holdings.isLoading && !holdings.isError && items.length === 0 && (
            <EmptyState
              icon={<PackageOpen className="h-12 w-12" />}
              title="暂无持仓数据"
              description={
                securityList.length === 0
                  ? '请先新建标的，再录入买卖流水；持仓将自动推导'
                  : '持仓由证券买卖流水实时推导，点击下方按钮录入第一笔买卖'
              }
              action={
                <Button onClick={() => setTradeDialogOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  录入买卖
                </Button>
              }
            />
          )}

          {!holdings.isLoading && !holdings.isError && items.length > 0 && (
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
                            {Number(h.quantity).toLocaleString('zh-CN', {
                              maximumFractionDigits: 4,
                            })}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            ¥{formatCurrency(h.avgCost)}
                          </TableCell>
                          <TableCell className="text-right">
                            <InlinePriceEditor
                              portfolioId={currentPortfolioId}
                              securityId={h.securityId}
                              value={h.marketPrice}
                              priceAsOf={h.priceAsOf}
                              flag={h.flag}
                            />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            ¥{formatCurrency(h.marketValue)}
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
          )}
        </div>

        {/* ============ 买卖明细 Tab ============ */}
        <div className="mt-4 space-y-4">
          {/* 【C】筛选 */}
          <Card>
            <CardContent className="pt-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">标的</Label>
                  <Select
                    value={filterSecurityId}
                    onValueChange={setFilterSecurityId}
                  >
                    <SelectTrigger className="w-[180px]">
                      <SelectValue placeholder="全部标的" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部标的</SelectItem>
                      {securityList.map((sec) => (
                        <SelectItem key={sec.id} value={sec.id}>
                          {sec.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">方向</Label>
                  <Select value={filterSide} onValueChange={setFilterSide}>
                    <SelectTrigger className="w-[110px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部</SelectItem>
                      <SelectItem value="BUY_SEC">买入</SelectItem>
                      <SelectItem value="SELL_SEC">卖出</SelectItem>
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
                  <Button size="sm" onClick={handleApplyTradeFilter}>
                    筛选
                  </Button>
                  <Button size="sm" variant="outline" onClick={handleResetTradeFilter}>
                    重置
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <SecurityTradeList
            portfolioId={currentPortfolioId}
            query={tradeQuery}
            sideFilter={filterSide}
          />
        </div>
      </Tabs>

      {/* 录入/编辑证券买卖弹窗 */}
      <Dialog open={tradeDialogOpen} onOpenChange={setTradeDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>录入买卖</DialogTitle>
          </DialogHeader>
          <SecurityTradeForm
            portfolioId={currentPortfolioId}
            onSuccess={() => setTradeDialogOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
