/**
 * pages/HoldingsPage.tsx — 持仓页（PRD §7.2 · 方案B 只读推导 + I-05 统一筛选器）
 *
 * - 标题「+ 录入买卖」按钮 → 打开证券买卖录入弹窗（不是跳出入金页！）
 * - 🆕 I-05：页面顶部单一「统一筛选器」（HoldingsToolbar 原地升级），持仓 / 买卖明细 /
 *   分红费用三板块共享，状态单一来源 = URL query（useUrlState<HoldingsFilterState>）：
 *   - 日期范围（range/from/to）→ 买卖明细 / 分红费用
 *   - 持仓日期 as-of（date）→ 持仓板块
 *   - 证券多选（sec）→ 三板块
 *   - 场景（scenario）→ 买卖明细（side）；持仓不适用（INC-04 后分红板块不再承接 scenario）
 *   - 类型多选（types）+ 显示已清仓（closed）→ 持仓板块（专属折叠区）
 * - 【A】持仓汇总：总市值 / 总成本 / 浮盈 / 总盈亏率 / 标的数（HOLD-B-P0-06）
 * - 【B】持仓列表（只读，由 security-trades 推导），PRD §5.2.3 全 11 列
 * - 【C】证券买卖明细流水：列表（筛选由统一筛选器派生，HOLD-B-P0-07）
 * - 【E】分红记录：按标的累计分红 + 明细 CRUD（HOLD-B-P0-10；INC-04 费用已并入证券买卖流水）
 * - 空态引导按钮 → 打开录入弹窗（与出入金页完全解耦）
 *
 * 排序（决策 Q-5 甲）：列表在前端按市值降序展示，不依赖后端排序参数。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { PackageOpen, Plus, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import type { HoldingsFilterState } from '@/features/holdings/holdings-query-params';
import { resolveQuickRange } from '@/features/query/quick-range';
import { useDefaultDateRange } from '@/features/query/use-default-date-range';
import {
  ENTRY_BUTTON_ICON_CLASS,
  ENTRY_BUTTON_LABELS,
  ENTRY_BUTTON_SIZE,
  ENTRY_BUTTON_VARIANT,
} from '@/constants/entry-button-labels';
import { usePortfolioStore, usePortfolioBaseDate } from '@/stores/portfolio.store';
import { usePreferenceStore } from '@/stores/preference.store';
import { usePortfolios } from '@/hooks/use-portfolios';
import { useHoldings } from '@/hooks/use-holdings';
import { useSecurities } from '@/hooks/use-securities';
import { useTransactions } from '@/hooks/use-transactions';
import { todayInAppTzIso, toIsoDate } from '@/lib/constants';
import { useUrlState } from '@/lib/url-query';
import { formatCurrency, formatPercent, cn } from '@/lib/utils';
import { SecuritySide } from '@/lib/types';
import { FeeScenario } from '@/api/types';
import type { SecurityTradeQuery } from '@/api/types';

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

  // ===== I-05：统一筛选器状态（单一来源 = URL query）=====
  // date / closed / types / sec / range / from / to / scenario 全部走 useUrlState：
  // 默认值不写入 URL、非法值降级、白名单外 key 保留；刷新/复制链接可还原。
  const today = todayInAppTzIso();
  const prefShowLiquidated = getPreference('showLiquidated');
  const defaultRange = useDefaultDateRange();
  const [holdingsQuery, setHoldingsQuery] = useUrlState<HoldingsFilterState>(
    createHoldingsSchema(today, prefShowLiquidated, defaultRange),
  );

  // 🔴 用户交互守卫（QA 第 1 轮 Bug 修复）：
  // 偏好对齐 effect 只允许在「偏好异步到达、且用户尚未主动操作该维度」时执行一次。
  // 用户一旦手动改过 range/from/to（或 closed），对应 ref 置 true，此后 effect 永不再对齐，
  // 避免「用户选择被偏好默认值弹回、URL 不写入」的问题（增量 PRD I-04 验收 2/3 + I-05 验收 5）。
  const rangeInteractedRef = useRef(false);
  const closedInteractedRef = useRef(false);

  /** 统一筛选器变更入口：标记用户交互 + 写入 URL（useUrlState flush 异步落 URL） */
  const handleFilterChange = (patch: Partial<HoldingsFilterState>) => {
    if (
      patch.range !== undefined ||
      patch.from !== undefined ||
      patch.to !== undefined
    ) {
      rangeInteractedRef.current = true;
    }
    if (patch.closed !== undefined) {
      closedInteractedRef.current = true;
    }
    setHoldingsQuery(patch);
  };

  // 偏好对齐 effect 1（closed）：偏好异步到达后，URL 无 closed 且用户未交互时对齐一次
  const hasClosedParam = useMemo(
    () => new URLSearchParams(window.location.search).has('closed'),
    [],
  );
  useEffect(() => {
    if (hasClosedParam || closedInteractedRef.current) return;
    if (prefShowLiquidated && !holdingsQuery.closed) {
      setHoldingsQuery({ closed: true });
    }
  }, [prefShowLiquidated, hasClosedParam, holdingsQuery.closed, setHoldingsQuery]);

  // 偏好对齐 effect 2（I-04）：偏好异步到达后，URL 无 range/from/to 且用户未交互时对齐一次
  const hasRangeParam = useMemo(() => {
    const sp = new URLSearchParams(window.location.search);
    return sp.has('range') || sp.has('from') || sp.has('to');
  }, []);
  useEffect(() => {
    if (hasRangeParam || rangeInteractedRef.current) return;
    if (
      holdingsQuery.range !== defaultRange &&
      defaultRange !== 'custom'
    ) {
      setHoldingsQuery({ range: defaultRange as HoldingsFilterState['range'] });
    }
  }, [defaultRange, hasRangeParam, holdingsQuery.range, setHoldingsQuery]);

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

  // 「全部」快捷项起点 = 组合首个交易日（问题②）
  const baseDate = usePortfolioBaseDate();

  // I-05 三板块联动：日期范围解析（range=custom 用 from/to；否则按快捷项）
  const { startDate, endDate } = useMemo(() => {
    if (
      holdingsQuery.range === 'custom' &&
      holdingsQuery.from &&
      holdingsQuery.to
    ) {
      return { startDate: holdingsQuery.from, endDate: holdingsQuery.to };
    }
    return resolveQuickRange(holdingsQuery.range, {
      allRangeStart: baseDate ?? undefined,
    });
  }, [holdingsQuery.range, holdingsQuery.from, holdingsQuery.to, baseDate]);

  // 【持仓板块】as-of 精确推导 + 证券/类型/已清仓过滤
  const holdings = useHoldings(currentPortfolioId, {
    date: holdingsQuery.date,
    includeClosed: holdingsQuery.closed,
    types: holdingsQuery.types.length > 0 ? holdingsQuery.types : undefined,
    securityId:
      holdingsQuery.sec.length > 0 ? holdingsQuery.sec.join(',') : undefined,
  });
  const securities = useSecurities(currentPortfolioId);

  // 【买卖明细板块】证券多值 + 场景→side + 日期范围
  const tradeQuery: SecurityTradeQuery = useMemo(() => {
    const q: SecurityTradeQuery = {};
    if (holdingsQuery.sec.length > 0) {
      q.securityId = holdingsQuery.sec.join(',');
    }
    if (holdingsQuery.scenario === 'BUY') {
      q.side = SecuritySide.BUY_SEC;
    }
    if (holdingsQuery.scenario === 'SELL') {
      q.side = SecuritySide.SELL_SEC;
    }
    q.startDate = startDate;
    q.endDate = endDate;
    return q;
  }, [holdingsQuery.sec, holdingsQuery.scenario, startDate, endDate]);

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
        // 后端金额/数量为字符串（Decimal→str 契约），算术前需 Number() 转换
        const aOpen = Number(a.quantity) > 0 ? 0 : 1;
        const bOpen = Number(b.quantity) > 0 ? 0 : 1;
        if (aOpen !== bOpen) return aOpen - bOpen;
        return Number(b.marketValue) - Number(a.marketValue);
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="持仓"
        description="持仓由证券买卖流水实时推导，只读展示；现价可内联修改"
        actions={
          <Button
            size={ENTRY_BUTTON_SIZE}
            variant={ENTRY_BUTTON_VARIANT}
            onClick={() => setTradeDialogOpen(true)}
          >
            <Plus className={ENTRY_BUTTON_ICON_CLASS} />
            {ENTRY_BUTTON_LABELS.securityTrade}
          </Button>
        }
      />

      {/* I-05 统一筛选器：三板块共享（持仓日期卡片重新设计承载） */}
      <HoldingsToolbar
        value={holdingsQuery}
        onChange={handleFilterChange}
        minDate={minDate}
        allRangeStart={baseDate}
        securities={securityList}
      />

      <Tabs defaultValue="holdings">
        <TabsList>
          <TabsTrigger value="holdings">持仓</TabsTrigger>
          <TabsTrigger value="trades">买卖明细</TabsTrigger>
          {/* 【E】HOLD-B-P0-10：分红 / 费用独立记录，不参与收益计算 */}
          <TabsTrigger value="income">分红</TabsTrigger>
        </TabsList>

        {/* ============ 持仓 Tab ============ */}
        <TabsContent value="holdings" className="mt-4 space-y-6">
          {/* 【A】汇总（HOLD-B-P0-06：含总盈亏率共 5 项；随筛选动态变化） */}
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
                /* INC-05：空态尺寸豁免，variant/图标/文案与页头主入口一致 */
                <Button
                  variant={ENTRY_BUTTON_VARIANT}
                  onClick={() => setTradeDialogOpen(true)}
                >
                  <Plus className={ENTRY_BUTTON_ICON_CLASS} />
                  {ENTRY_BUTTON_LABELS.securityTrade}
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
                        aggregate && Number(aggregate.totalMarketValue) > 0
                          ? Number(h.marketValue) / Number(aggregate.totalMarketValue)
                          : 0;
                      return (
                        <TableRow key={h.securityId}>
                          <TableCell className="font-medium">
                            <div className="flex items-center gap-2">
                              {h.securityName}
                              {Number(h.quantity) === 0 && (
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
        {/* I-05：筛选由统一筛选器派生（日期范围/证券/场景），不再本 Tab 独立筛选 */}
        <TabsContent value="trades" className="mt-4 space-y-4">
          <SecurityTradeList
            portfolioId={currentPortfolioId}
            query={tradeQuery}
            sideFilter="all"
          />
        </TabsContent>

        {/* ============ 【E】分红 / 费用 Tab（HOLD-B-P0-10 + I-05 筛选联动） ============ */}
        <TabsContent value="income" className="mt-4">
          <DividendFeeSection
            portfolioId={currentPortfolioId}
            securityIds={holdingsQuery.sec}
            startDate={startDate}
            endDate={endDate}
          />
        </TabsContent>
      </Tabs>

      {/* 录入/编辑证券买卖弹窗 */}
      <Dialog open={tradeDialogOpen} onOpenChange={setTradeDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{ENTRY_BUTTON_LABELS.securityTrade}</DialogTitle>
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
