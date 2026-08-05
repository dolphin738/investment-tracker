/**
 * pages/HoldingsPage.tsx — 持仓页（PRD §7.2 · 方案B 只读推导）
 *
 * - 标题「+ 录入买卖」按钮 → 打开证券买卖录入弹窗（不是跳出入金页！）
 * - 【A】持仓汇总：总市值 / 总成本 / 浮盈 / 总盈亏率 / 标的数（HOLD-B-P0-06）
 * - 【B】持仓列表（只读，由 security-trades 推导），PRD §5.2.3 全 11 列：
 *   标的/代码/类型/数量/成本价/现价/成本额/市值/浮动盈亏/盈亏率/占比
 *   （HOLD-B-P0-03 / P0-04；现价支持内联编辑，占比带横向进度条）
 * - 【C】证券买卖明细流水：列表 + 筛选（标的/日期/方向）+ 编辑/删除
 * - 【E】分红 / 费用记录：按标的累计分红与累计费用 + 明细 CRUD（HOLD-B-P0-10）
 * - 空态引导按钮 → 打开录入弹窗（与出入金页完全解耦）
 *
 * 排序（决策 Q-5 甲）：列表在前端按市值降序展示，不依赖后端排序参数。
 *
 * 版式说明（阶段 C）：草图把【E】画作页面末尾的独立区块，但本页自阶段 A 起
 * 已把【C】收敛为 Tab；【E】沿用同一模式作为第三个 Tab，与【C】保持一致，
 * 同时避免与【B】持仓表并列造成长页滚动。功能验收（按标的查看累计分红/费用）不变。
 */

import { useEffect, useMemo, useState } from 'react';
import { PackageOpen, Plus, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
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
import { DividendFeeSection } from '@/features/security-income/dividend-fee-section';
import { HoldingsToolbar } from '@/features/holdings/holdings-toolbar';
import { createHoldingsSchema } from '@/features/holdings/holdings-query-params';
import type { HoldingsQueryState } from '@/features/holdings/holdings-query-params';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { usePreferenceStore } from '@/stores/preference.store';
import { usePortfolios } from '@/hooks/use-portfolios';
import { useHoldings } from '@/hooks/use-holdings';
import { useSecurities } from '@/hooks/use-securities';
import { useTransactions } from '@/hooks/use-transactions';
import { todayInAppTzIso, toIsoDate } from '@/lib/constants';
import { useUrlState } from '@/lib/url-query';
import { formatCurrency, formatPercent, cn } from '@/lib/utils';

// ===== 常量 =====
const SECURITY_TYPE_LABEL: Record<string, string> = {
  STOCK: '股票',
  FUND: '基金',
  BOND: '债券',
  CASH: '现金',
  OTHER: '其他',
};

export default function HoldingsPage(): JSX.Element {
  const currentPortfolioId = usePortfolioStore((s) => s.currentPortfolioId);
  const { data: portfolios = [], isLoading: portfoliosLoading } = usePortfolios();
  const getPreference = usePreferenceStore((s) => s.getPreference);
  const amountThousands = getPreference('amountThousands');
  const amountAbbrev = getPreference('amountAbbrev');
  // 盈亏率 / 总盈亏率沿用「收益率小数位」偏好（与概览页、分析页口径一致）
  const xirrDecimals = getPreference('xirrDecimals');

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

  // ===== 持仓查询状态（T02 · URL 持久化）=====
  // date / closed / types / sec 四个 key 全部走 useUrlState（lib/url-query）：
  // 默认值不写入 URL、非法值降级、白名单外 key 保留；刷新/复制链接可还原。
  const today = todayInAppTzIso();
  const prefShowLiquidated = getPreference('showLiquidated');
  const [holdingsQuery, setHoldingsQuery] = useUrlState<HoldingsQueryState>(
    createHoldingsSchema(today, prefShowLiquidated),
  );

  // 「显示已清仓」初值 = UserPreference.showLiquidated；URL 参数优先级更高。
  // useUrlState 的默认值在首帧固化，偏好异步到达后需主动对齐一次（URL 无 closed 时）。
  const hasClosedParam = useMemo(
    () => new URLSearchParams(window.location.search).has('closed'),
    [],
  );
  useEffect(() => {
    if (!hasClosedParam && prefShowLiquidated && !holdingsQuery.closed) {
      setHoldingsQuery({ closed: true });
    }
  }, [prefShowLiquidated, hasClosedParam, holdingsQuery.closed, setHoldingsQuery]);

  // 日期选择器下限（O-4 方案甲，零后端改动）：首个交易日（useTransactions 首条）；
  // 无交易 → 组合创建日；恒 ≤ 今天。
  const firstTradeQuery = useTransactions(currentPortfolioId, {
    page: 1,
    pageSize: 1,
    sortBy: 'date',
    sortOrder: 'asc',
  });
  const currentPortfolio = portfolios.find((p) => p.id === currentPortfolioId);
  const minDate = useMemo(() => {
    const firstTradeDate = firstTradeQuery.data?.items?.[0]?.date;
    if (firstTradeDate) return firstTradeDate;
    return currentPortfolio?.createdAt
      ? toIsoDate(new Date(currentPortfolio.createdAt))
      : today;
  }, [firstTradeQuery.data, currentPortfolio, today]);

  const holdings = useHoldings(currentPortfolioId, {
    date: holdingsQuery.date,
    includeClosed: holdingsQuery.closed,
    types: holdingsQuery.types.length > 0 ? holdingsQuery.types : undefined,
    securityId: holdingsQuery.sec || undefined,
  });
  const securities = useSecurities(currentPortfolioId);

  /**
   * 【A4】持仓列表前端排序（决策 Q-5 甲）：默认按市值降序。
   *
   * - 必须放在所有早退分支之前，遵守 Hooks 调用顺序恒定的规则。
   * - 复制后再 sort，避免原地修改 react-query 缓存数组。
   * - 占比权重基于 aggregate.totalMarketValue 计算，排序不影响权重。
   * - T02 追加：正常持仓（qty>0）恒排在已清仓（qty=0）之前；同组内市值降序。
   */
  const sortedItems = useMemo(
    () =>
      [...(holdings.data?.items ?? [])].sort((a, b) => {
        const aOpen = a.quantity > 0 ? 0 : 1;
        const bOpen = b.quantity > 0 ? 0 : 1;
        if (aOpen !== bOpen) return aOpen - bOpen;
        return b.marketValue - a.marketValue;
      }),
    [holdings.data?.items],
  );

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

      {/* T02 工具栏：日期选择器 + 显示已清仓 + 类型多选（URL 持久化） */}
      <HoldingsToolbar
        date={holdingsQuery.date}
        minDate={minDate}
        includeClosed={holdingsQuery.closed}
        types={holdingsQuery.types}
        onDateChange={(v) => setHoldingsQuery({ date: v })}
        onClosedChange={(v) => setHoldingsQuery({ closed: v })}
        onTypesChange={(v) => setHoldingsQuery({ types: v })}
      />

      <Tabs defaultValue="holdings">
        <TabsList>
          <TabsTrigger value="holdings">持仓</TabsTrigger>
          <TabsTrigger value="trades">买卖明细</TabsTrigger>
          {/* 【E】HOLD-B-P0-10：分红 / 费用独立记录，不参与收益计算 */}
          <TabsTrigger value="income">分红/费用</TabsTrigger>
        </TabsList>

        {/* ============ 持仓 Tab ============ */}
        {/* 【A1】必须用 TabsContent 包裹，否则两个区块恒同时渲染、Tab 切换失效 */}
        <TabsContent value="holdings" className="mt-4 space-y-6">
          {/* 【A】汇总（HOLD-B-P0-06：含总盈亏率共 5 项） */}
          {aggregate && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <Card>
                <CardContent className="py-3">
                  <p className="text-xs text-muted-foreground">总市值</p>
                  <p className="text-lg font-bold tabular-nums">
                    {formatCurrency(aggregate.totalMarketValue, 2, { thousands: amountThousands, abbreviate: amountAbbrev })}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-3">
                  <p className="text-xs text-muted-foreground">总成本</p>
                  <p className="text-lg font-bold tabular-nums">
                    {formatCurrency(aggregate.totalCost, 2, { thousands: amountThousands, abbreviate: amountAbbrev })}
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
                    {formatCurrency(aggregate.totalProfit, 2, { thousands: amountThousands, abbreviate: amountAbbrev })}
                  </p>
                </CardContent>
              </Card>
              {/* 【A3】总盈亏率（HOLD-B-P0-06）：红涨绿跌（§9.5） */}
              <Card>
                <CardContent className="py-3">
                  <p className="text-xs text-muted-foreground">总盈亏率</p>
                  <p
                    className={cn(
                      'text-lg font-bold tabular-nums',
                      aggregate.totalProfitRate >= 0 ? 'text-up' : 'text-down',
                    )}
                  >
                    {formatPercent(aggregate.totalProfitRate, 2, {
                      decimals: xirrDecimals,
                    })}
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

          {holdings.isLoading && <TableSkeleton rows={5} cols={11} />}

          {!holdings.isLoading && !holdings.isError && sortedItems.length === 0 && (
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

          {!holdings.isLoading && !holdings.isError && sortedItems.length > 0 && (
            <Card>
              <div className="overflow-x-auto">
                <Table>
                  {/* 【A2】PRD §5.2.3 全 11 列，顺序不可调整 */}
                  <TableHeader>
                    <TableRow>
                      <TableHead>标的</TableHead>
                      <TableHead>代码</TableHead>
                      <TableHead>类型</TableHead>
                      <TableHead className="text-right">数量</TableHead>
                      <TableHead className="text-right">成本价</TableHead>
                      <TableHead className="text-right">现价</TableHead>
                      <TableHead className="text-right">成本额</TableHead>
                      <TableHead className="text-right">市值</TableHead>
                      <TableHead className="text-right">浮动盈亏</TableHead>
                      <TableHead className="text-right">盈亏率</TableHead>
                      <TableHead className="text-right">占比</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedItems.map((h) => {
                      const weight =
                        aggregate && aggregate.totalMarketValue > 0
                          ? h.marketValue / aggregate.totalMarketValue
                          : 0;
                      return (
                        <TableRow key={h.securityId}>
                          <TableCell className="font-medium">
                            <div className="flex items-center gap-2">
                              {h.securityName}
                              {h.quantity === 0 && (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] text-muted-foreground"
                                  title="已清仓标的（数量为 0）"
                                >
                                  已清仓
                                </Badge>
                              )}
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
                            {formatCurrency(h.avgCost, 2, { thousands: amountThousands, abbreviate: amountAbbrev })}
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
                          {/* 【A2】成本额 */}
                          <TableCell className="text-right tabular-nums">
                            {formatCurrency(h.costTotal, 2, { thousands: amountThousands, abbreviate: amountAbbrev })}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatCurrency(h.marketValue, 2, { thousands: amountThousands, abbreviate: amountAbbrev })}
                          </TableCell>
                          {/* 【A2】浮动盈亏：带正负号，红涨绿跌（§9.5） */}
                          <TableCell
                            className={cn(
                              'text-right tabular-nums',
                              h.pnl >= 0 ? 'text-up' : 'text-down',
                            )}
                          >
                            {h.pnl >= 0 ? '+' : ''}
                            {formatCurrency(h.pnl, 2, { thousands: amountThousands, abbreviate: amountAbbrev })}
                          </TableCell>
                          {/* 【A2】盈亏率：红涨绿跌（§9.5） */}
                          <TableCell
                            className={cn(
                              'text-right tabular-nums',
                              h.pnlRate >= 0 ? 'text-up' : 'text-down',
                            )}
                          >
                            {formatPercent(h.pnlRate, 2, { decimals: xirrDecimals })}
                          </TableCell>
                          {/* 【A5】占比：数值 + 横向进度条（HOLD-B-P0-04 验收5） */}
                          <TableCell className="text-right tabular-nums">
                            <div className="flex flex-col items-end gap-1">
                              <span>{formatPercent(weight)}</span>
                              <Progress
                                value={weight * 100}
                                className="h-1.5 w-16"
                                aria-label={`占比 ${formatPercent(weight)}`}
                              />
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </Card>
          )}
        </TabsContent>

        {/* ============ 买卖明细 Tab ============ */}
        <TabsContent value="trades" className="mt-4 space-y-4">
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
        </TabsContent>

        {/* ============ 【E】分红 / 费用 Tab（HOLD-B-P0-10） ============ */}
        <TabsContent value="income" className="mt-4">
          <DividendFeeSection portfolioId={currentPortfolioId} />
        </TabsContent>
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
