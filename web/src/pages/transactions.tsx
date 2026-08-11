/**
 * pages/transactions.tsx — 出入金管理页（PRD §7.1 · 改版：统一筛选器 + Tab 分页）
 *
 * 注：原【A】总资产展示卡片（当前总资产 / 持仓市值 / 近30日走势图 / 手工记录标记）
 * 已按 docs/designs/overview-fusion-2026-08-06.md 整体
 * 迁移至概览页（dashboard），本页不再展示总资产。
 *
 * 【改版要点】对齐持仓页 HoldingsPage 的「统一筛选器 + Tabs」范式：
 * 1. **筛选器合并**：页面顶部单一筛选器，取代原先「出入金流水」「现金余额」各自
 *    独立的两套筛选。日期范围对**两个页签同时生效**；类型多选与排序仅作用于
 *    「出入金流水」（现金余额没有类型/排序维度 —— 后端 CashBalanceQuery 只有
 *    startDate/endDate/page/pageSize），控件上就近标注作用范围，避免误解。
 * 2. **Tab 分页切换**：【出入金流水】/【现金余额】两个页签，复用与持仓页同一套
 *    `components/ui/tabs`。Tabs 受控（useState）——FLOW-P0-06 软提示需要程序化
 *    切到「现金余额」页签并打开录入弹窗。
 * 3. **现金余额页签版式**参照「买卖明细」：上方当前余额（+ⓘ 提示），下方余额变更
 *    历史表格，每条支持编辑 / 删除（删除触发后端重算 + 前端缓存失效）。
 * 4. **录入弹窗**：现金余额新增改为弹出对话框；编辑同一弹窗复用 `CashBalanceForm`。
 *
 * 筛选/排序/分页仍全部写入 URL query（FLOW-P0-02 验收2：刷新/分享保持）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Info, Plus, RotateCcw } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { CashflowForm } from '@/features/cashflow/cashflow-form';
import { CashflowList } from '@/features/cashflow/cashflow-list';
import { CashBalanceForm } from '@/features/cashflow/cash-balance-form';
import { CashBalanceHistory } from '@/features/cashflow/cash-balance-history';
import {
  parseTransactionSearchParams,
  SORT_OPTIONS,
  TRANSACTION_TYPE_OPTIONS,
  typesToParam,
  type TransactionTypeOption,
} from '@/features/cashflow/query-params';
import { CASH_BALANCE_FOCUS_EVENT } from '@/hooks/use-transactions';
import {
  usePortfolioBaseDate,
  usePortfolioStore,
} from '@/stores/portfolio.store';
import { usePreferenceStore } from '@/stores/preference.store';
import { usePortfolios } from '@/hooks/use-portfolios';
import { useLatestCashBalance } from '@/hooks/use-cash-balances';
import { DateRangeQuickPicker } from '@/components/date/date-range-quick-picker';
import { resolveQuickRange } from '@/features/query/quick-range';
import { useDefaultDateRange } from '@/features/query/use-default-date-range';
import {
  ENTRY_BUTTON_ICON_CLASS,
  ENTRY_BUTTON_LABELS,
  ENTRY_BUTTON_SIZE,
  ENTRY_BUTTON_VARIANT,
} from '@/constants/entry-button-labels';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { CashBalanceResponse, TransactionQuery } from '@/api/types';

/** 页签标识（不写 URL，与持仓页 Tabs 同口径） */
type TransactionTab = 'cashflow' | 'balance';

export default function TransactionsPage(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentPortfolioId = usePortfolioStore((s) => s.currentPortfolioId);
  // 「全部」快捷项的起点 = 组合首个交易日（问题②）
  const baseDate = usePortfolioBaseDate();
  // I-04：默认日期范围 = 偏好（URL 无 startDate/endDate 时），非法/空回落 '1y'
  const defaultRange = useDefaultDateRange();
  const { data: portfolios = [], isLoading: portfoliosLoading } = usePortfolios();
  const getPreference = usePreferenceStore((s) => s.getPreference);
  const amountThousands = getPreference('amountThousands');
  const amountAbbrev = getPreference('amountAbbrev');

  /** 当前页签（受控：软提示需要程序化切到「现金余额」） */
  const [tab, setTab] = useState<TransactionTab>('cashflow');
  /** 出入金录入弹窗 */
  const [open, setOpen] = useState(false);
  /** 现金余额录入/编辑弹窗（editingBalance 为 null 即新增） */
  const [balanceDialogOpen, setBalanceDialogOpen] = useState(false);
  const [editingBalance, setEditingBalance] = useState<CashBalanceResponse | null>(
    null,
  );

  // ── 统一筛选/排序/分页 ← URL query（FLOW-P0-02 验收2：刷新/分享保持） ──
  const parsed = useMemo(
    () => parseTransactionSearchParams(searchParams),
    [searchParams],
  );
  const {
    types,
    startDate: urlStartDate,
    endDate: urlEndDate,
    sortBy,
    sortOrder,
    page,
    pageSize,
  } = parsed;

  /**
   * INC-01：快捷范围受控回显（URL `range` 为唯一真相源）。
   *
   * 【为什么本页不用 `useRangePreferenceSync`（决策 E 的等价实现）】
   * 该 hook 解决的是「状态被 useState 冻结在首帧、偏好异步到达后不生效」。
   * 本页范围状态完全存放在 URL 上，可**同步派生**：
   *   - URL 有 `range` → 用它（用户已显式指定，偏好后续变化不再弹回）；
   *   - URL 只有 startDate/endDate（手动改过日期）→ 回显占位「自定义」；
   *   - URL 全空 → 回落偏好 `defaultRange`，偏好一到达即自动生效。
   * 派生写法天然满足「不覆盖用户选择 / 偏好可迟到」两条约束，且不会像
   * effect 方案那样在挂载时反写 URL（污染分享链接 + 「重置」后回显错位）。
   */
  const urlRange = searchParams.get('range') ?? '';
  const hasExplicitDates = Boolean(urlStartDate || urlEndDate);
  const quickValue = urlRange || (hasExplicitDates ? '' : defaultRange);
  const fallbackRangeValue = useMemo(
    () =>
      resolveQuickRange(quickValue || defaultRange, {
        allRangeStart: baseDate ?? undefined,
      }),
    [quickValue, defaultRange, baseDate],
  );

  // URL 参数优先；无 startDate/endDate 时按 quickValue（偏好或 URL range）解析
  const filterStartDate = urlStartDate || fallbackRangeValue.startDate;
  const filterEndDate = urlEndDate || fallbackRangeValue.endDate;

  /** 更新 URL query（null / '' 删除该参数；变更即生效，无需「筛选」按钮） */
  const updateParams = useCallback(
    (patch: Record<string, string | number | null>) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(patch)) {
          if (value === null || value === undefined || value === '') {
            next.delete(key);
          } else {
            next.set(key, String(value));
          }
        }
        return next;
      });
    },
    [setSearchParams],
  );

  /** 类型多选切换（全不勾 = 全部，Part E-1） */
  const handleToggleType = (t: TransactionTypeOption) => {
    const next = types.includes(t) ? types.filter((x) => x !== t) : [...types, t];
    updateParams({ types: typesToParam(next), page: 1 });
  };

  /** 重置：清空全部筛选/排序/分页参数（回落到 全部 + date desc + 第 1 页 + 20 条） */
  const handleResetFilter = useCallback(() => {
    setSearchParams({});
  }, [setSearchParams]);

  /** 排序切换（value = `${sortBy}:${sortOrder}`，如 date:desc） */
  const handleSortChange = (v: string) => {
    const [by, order] = v.split(':');
    updateParams({ sortBy: by, sortOrder: order, page: 1 });
  };

  const handlePageChange = (p: number) => {
    updateParams({ page: p });
  };

  const handlePageSizeChange = (size: number) => {
    updateParams({ pageSize: size, page: 1 });
  };

  /**
   * 传给出入金流水列表的查询参数：日期范围 + 非默认排序。
   * F5 仅非默认时透传（默认 date desc 与后端现状一致，避免后端 F5 未落盘时白名单 400）。
   */
  const listQuery: TransactionQuery = useMemo(() => {
    const q: TransactionQuery = {};
    if (filterStartDate) q.startDate = filterStartDate;
    if (filterEndDate) q.endDate = filterEndDate;
    if (sortBy === 'amount' || sortOrder === 'asc') {
      q.sortBy = sortBy;
      q.sortOrder = sortOrder;
    }
    return q;
  }, [filterStartDate, filterEndDate, sortBy, sortOrder]);

  const latestBalance = useLatestCashBalance(currentPortfolioId);
  const cashBalance = latestBalance.data?.amount;

  /** 打开现金余额新增弹窗 */
  const openCreateBalance = useCallback(() => {
    setEditingBalance(null);
    setBalanceDialogOpen(true);
  }, []);

  /** 打开现金余额编辑弹窗（复用同一表单组件） */
  const openEditBalance = useCallback((row: CashBalanceResponse) => {
    setEditingBalance(row);
    setBalanceDialogOpen(true);
  }, []);

  // FLOW-P0-06：监听软提示「去更新」事件 → 切到「现金余额」页签并打开录入弹窗
  // （只引导，绝不自动修改 CashBalance；事件由 use-transactions 的 soft hint action 派发）
  useEffect(() => {
    const handler = () => {
      setTab('balance');
      openCreateBalance();
    };
    window.addEventListener(CASH_BALANCE_FOCUS_EVENT, handler);
    return () => window.removeEventListener(CASH_BALANCE_FOCUS_EVENT, handler);
  }, [openCreateBalance]);

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
          <h1 className="text-2xl font-bold tracking-tight">出入金管理</h1>
          <p className="text-sm text-muted-foreground">
            管理存入/取出现金流与现金余额，系统据此计算净值与 XIRR
          </p>
        </div>
        {/* INC-05：与概览页「录入买卖」同规格（主色 + sm + Plus），文案取统一字典；
            录入现金余额置于录入出入金左侧，两者水平并排、规格一致便于操作 */}
        <div className="flex items-center gap-2">
          <Button
            onClick={openCreateBalance}
            variant={ENTRY_BUTTON_VARIANT}
            size={ENTRY_BUTTON_SIZE}
          >
            <Plus className={ENTRY_BUTTON_ICON_CLASS} />
            {ENTRY_BUTTON_LABELS.cashBalance}
          </Button>
          <Button
            onClick={() => setOpen(true)}
            variant={ENTRY_BUTTON_VARIANT}
            size={ENTRY_BUTTON_SIZE}
          >
            <Plus className={ENTRY_BUTTON_ICON_CLASS} />
            {ENTRY_BUTTON_LABELS.cashFlow}
          </Button>
        </div>
      </div>

      {/* ============ 统一筛选器（两个页签共享，变更即写入 URL query） ============ */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">筛选</CardTitle>
          <CardDescription>
            日期范围对「出入金流水」与「现金余额」同时生效；类型与排序仅作用于出入金流水
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            {/*
              问题⑥：把「不勾选 = 全部」并入 Label。原先它是控件下方独立的 <p>，
              使「类型」这一列比其它列高出一行；在 items-end 下各列按底边对齐，
              类型框就会整体上浮、与日期/排序控件错位。并入 Label 后，每一列
              都是「Label + h-9 控件」的等高结构，天然对齐。
            */}
            <div className="space-y-1.5">
              <Label className="text-xs">类型（不勾选 = 全部 · 仅流水）</Label>
              <div className="flex h-9 items-center gap-4 rounded-md border border-input px-3">
                {TRANSACTION_TYPE_OPTIONS.map((t) => (
                  <label
                    key={t}
                    className="flex cursor-pointer items-center gap-1.5 text-sm"
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={types.includes(t)}
                      onChange={() => handleToggleType(t)}
                    />
                    <span className={t === 'BUY' ? 'text-up' : 'text-down'}>
                      {t === 'BUY' ? '存入' : '取出'}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            {/* 问题⑤⑥：接入共享快捷范围控件，与资产记录页同一实现 */}
            <DateRangeQuickPicker
              quick={quickValue}
              startDate={filterStartDate}
              endDate={filterEndDate}
              allRangeStart={baseDate}
              onChange={(r) =>
                updateParams({
                  // 选中快捷项 → 写 range；手动改日期 → 清 range（回显占位）
                  range: r.quick || null,
                  startDate: r.startDate || null,
                  endDate: r.endDate || null,
                  page: 1,
                })
              }
            />
            <div className="space-y-1.5">
              <Label className="text-xs">排序（仅流水）</Label>
              <Select value={`${sortBy}:${sortOrder}`} onValueChange={handleSortChange}>
                <SelectTrigger className="w-[130px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SORT_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={handleResetFilter}>
                <RotateCcw className="mr-1 h-3.5 w-3.5" />
                重置
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ============ 页签：出入金流水 / 现金余额 ============ */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as TransactionTab)}>
        <TabsList>
          <TabsTrigger value="cashflow">出入金流水</TabsTrigger>
          <TabsTrigger value="balance">现金余额</TabsTrigger>
        </TabsList>

        {/* ---------- 出入金流水 ---------- */}
        <TabsContent value="cashflow" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">出入金流水</CardTitle>
              <CardDescription>
                按顶部统一筛选器的日期范围 / 类型 / 排序展示；编辑/删除将触发重算
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CashflowList
                portfolioId={currentPortfolioId}
                query={listQuery}
                types={types}
                page={page}
                pageSize={pageSize}
                onPageChange={handlePageChange}
                onPageSizeChange={handlePageSizeChange}
                onClearFilter={handleResetFilter}
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---------- 现金余额（版式参照「买卖明细」：上当前值 + 下变更历史） ---------- */}
        <TabsContent value="balance" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">现金余额（手工维护）</CardTitle>
              <CardDescription>
                维护组合现金余额，生效日起前向沿用；保存/删除均触发净值/XIRR 重算
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* 当前余额展示行（CASH-P0-02 验收1）；录入入口已统一到页头按钮组 */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/40 p-4">
                <div>
                  <p className="text-xs text-muted-foreground">当前余额</p>
                  <p className="mt-1 text-xl font-bold tabular-nums">
                    {cashBalance !== undefined && cashBalance !== null
                      ? formatCurrency(cashBalance, 2, {
                          thousands: amountThousands,
                          abbreviate: amountAbbrev,
                        })
                      : '未维护，请点击右上角「录入现金余额」'}
                  </p>
                  {cashBalance !== undefined &&
                    cashBalance !== null &&
                    latestBalance.data && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        自 {formatDate(latestBalance.data.asOf)} 起沿用
                      </p>
                    )}
                </div>
              </div>

              {/* CASH-P0-03 两条 ⓘ 提示 */}
              <ul className="space-y-1.5 text-xs text-muted-foreground">
                <li className="flex items-start gap-1.5">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>存取与证券买卖不会自动调整此值，请在操作后自行更新。</span>
                </li>
                <li className="flex items-start gap-1.5">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    修改后自该日起的自动总资产记录将重新计算（您手工记录的日期会被跳过）。
                  </span>
                </li>
              </ul>

              {/* 余额变更历史（受顶部统一筛选器的日期范围约束，每条可编辑/删除） */}
              <div>
                <p className="mb-2 text-sm font-medium">余额变更历史</p>
                <CashBalanceHistory
                  portfolioId={currentPortfolioId}
                  startDate={filterStartDate}
                  endDate={filterEndDate}
                  onEdit={openEditBalance}
                  onClearFilter={handleResetFilter}
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* 录入/编辑出入金弹窗 */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{ENTRY_BUTTON_LABELS.cashFlow}</DialogTitle>
          </DialogHeader>
          <CashflowForm
            portfolioId={currentPortfolioId}
            onSuccess={() => setOpen(false)}
          />
        </DialogContent>
      </Dialog>

      {/* 录入/编辑现金余额弹窗（新增与编辑复用同一表单组件） */}
      <Dialog
        open={balanceDialogOpen}
        onOpenChange={(o) => {
          setBalanceDialogOpen(o);
          if (!o) setEditingBalance(null);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingBalance ? '编辑现金余额' : ENTRY_BUTTON_LABELS.cashBalance}
            </DialogTitle>
          </DialogHeader>
          <CashBalanceForm
            portfolioId={currentPortfolioId}
            balance={editingBalance}
            onSuccess={() => {
              setBalanceDialogOpen(false);
              setEditingBalance(null);
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
