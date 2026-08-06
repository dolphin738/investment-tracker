/**
 * pages/transactions.tsx — 出入金管理页（PRD §7.1）
 *
 * 注：原【A】总资产展示卡片（当前总资产 / 持仓市值 / 近30日走势图 / 手工记录标记 +
 * 两个 /snapshots 入口）已按 docs/designs/overview-fusion-2026-08-06.md 整体
 * 迁移至概览页（dashboard），本页不再展示总资产。
 * 【B】现金余额（手工维护）：当前余额展示行 + ⓘ 提示 + 金额/生效日期/保存（调 cash-balance API）
 * 【C】出入金流水列表：类型多选 checkbox（全不勾=全部）+ 日期范围 + 排序 + 分页（20/50/100）
 *   —— 筛选/排序/分页全部写入 URL query（FLOW-P0-02 验收2：刷新/分享保持）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Camera,
  Info,
  Plus,
  RotateCcw,
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
import { useLatestCashBalance, useUpsertCashBalance } from '@/hooks/use-cash-balances';
import { DateRangeQuickPicker } from '@/components/date/date-range-quick-picker';
import { toIsoDate } from '@/lib/constants';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { TransactionQuery } from '@/api/types';

export default function TransactionsPage(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentPortfolioId = usePortfolioStore((s) => s.currentPortfolioId);
  // 「全部」快捷项的起点 = 组合首个交易日（问题②）
  const baseDate = usePortfolioBaseDate();
  const { data: portfolios = [], isLoading: portfoliosLoading } = usePortfolios();
  const getPreference = usePreferenceStore((s) => s.getPreference);
  const amountThousands = getPreference('amountThousands');
  const amountAbbrev = getPreference('amountAbbrev');
  const [open, setOpen] = useState(false);

  // ── 【C】筛选/排序/分页 ← URL query（FLOW-P0-02 验收2：刷新/分享保持） ──
  const parsed = useMemo(
    () => parseTransactionSearchParams(searchParams),
    [searchParams],
  );
  const {
    types,
    startDate: filterStartDate,
    endDate: filterEndDate,
    sortBy,
    sortOrder,
    page,
    pageSize,
  } = parsed;

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
  const handleResetFilter = () => {
    setSearchParams({});
  };

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
   * 传给列表的查询参数：日期范围 + 非默认排序。
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

  // ── 【B】现金余额维护 ──
  const [balanceAmount, setBalanceAmount] = useState('');
  const [balanceDate, setBalanceDate] = useState(toIsoDate(new Date()));
  const upsertBalanceMutation = useUpsertCashBalance();
  const balanceAmountRef = useRef<HTMLInputElement>(null);

  // FLOW-P0-06：监听软提示「去更新」事件 → 聚焦【B】金额输入框
  // （只聚焦，绝不自动修改 CashBalance；事件由 use-transactions 的 soft hint action 派发）
  useEffect(() => {
    const handler = () => {
      balanceAmountRef.current?.focus();
      balanceAmountRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    window.addEventListener(CASH_BALANCE_FOCUS_EVENT, handler);
    return () => window.removeEventListener(CASH_BALANCE_FOCUS_EVENT, handler);
  }, []);

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
      {
        // 保存后清空输入；latestBalance 因 useUpsertCashBalance invalidate 自动刷新 → 展示最新余额
        onSuccess: () => setBalanceAmount(''),
      },
    );
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
          <h1 className="text-2xl font-bold tracking-tight">出入金管理</h1>
          <p className="text-sm text-muted-foreground">
            管理存入/取出现金流，系统据此计算净值与 XIRR
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          新增出入金
        </Button>
      </div>

      {/* 【B】现金余额（手工维护） */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">现金余额（手工维护）</CardTitle>
          <CardDescription>
            维护组合现金余额，生效日起前向沿用；保存后触发净值/XIRR 重算
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* 当前余额展示行（CASH-P0-02 验收1） */}
          <div className="mb-4 rounded-lg bg-muted/40 p-4">
            <p className="text-xs text-muted-foreground">当前余额</p>
            <p className="mt-1 text-xl font-bold tabular-nums">
              {cashBalance !== undefined && cashBalance !== null
                ? formatCurrency(cashBalance, 2, { thousands: amountThousands, abbreviate: amountAbbrev })
                : '未维护，可在下方录入'}
            </p>
            {cashBalance !== undefined && cashBalance !== null && latestBalance.data && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                自 {formatDate(latestBalance.data.asOf)} 起沿用
              </p>
            )}
          </div>

          {/* CASH-P0-03 两条 ⓘ 提示 */}
          <ul className="mb-4 space-y-1.5 text-xs text-muted-foreground">
            <li className="flex items-start gap-1.5">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>存取与证券买卖不会自动调整此值，请在操作后自行更新。</span>
            </li>
            <li className="flex items-start gap-1.5">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>修改后自该日起的自动总资产记录将重新计算（您手工记录的日期会被跳过）。</span>
            </li>
          </ul>

          {/* CASH-P1-01 / T04：现金余额变更历史展开器（默认收起，不写 URL） */}
          <CashBalanceHistory portfolioId={currentPortfolioId} className="mb-3" />

          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="balance-amount" className="text-xs">
                金额（元）
              </Label>
              <Input
                id="balance-amount"
                ref={balanceAmountRef}
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
          <CardDescription>支持按日期范围与类型多选筛选、排序；编辑/删除将触发重算</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 筛选栏（变更即写入 URL query，FLOW-P0-02 验收2） */}
          <div className="flex flex-wrap items-end gap-3">
            {/*
              问题⑥：把「不勾选 = 全部」并入 Label。原先它是控件下方独立的 <p>，
              使「类型」这一列比其它列高出一行；在 items-end 下各列按底边对齐，
              类型框就会整体上浮、与日期/排序控件错位。并入 Label 后，每一列
              都是「Label + h-9 控件」的等高结构，天然对齐。
            */}
            <div className="space-y-1.5">
              <Label className="text-xs">类型（不勾选 = 全部）</Label>
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
              startDate={filterStartDate}
              endDate={filterEndDate}
              endLabel="截止日期"
              allRangeStart={baseDate}
              onChange={(r) =>
                updateParams({
                  startDate: r.startDate || null,
                  endDate: r.endDate || null,
                  page: 1,
                })
              }
            />
            <div className="space-y-1.5">
              <Label className="text-xs">排序</Label>
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
