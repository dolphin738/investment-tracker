/**
 * features/cashflow/cash-balance-history.tsx — 现金余额变更历史展开器（T04 · CASH-P1-01 / AL-046）
 *
 * - 「查看变更历史 ▾」折叠区（**默认收起**，纯 UI 局部状态，不写 URL）。
 * - 展开后按 `asOf` 倒序分页列出（生效日 / 金额 / 备注 / 更新时间），pageSize 20。
 * - 每行可**编辑**（改金额 / 备注 → upsert，按 asOf 覆盖）与**删除**（remove），
 *   均由后端触发 recalculateRange（T4 级联）。
 * - 成功 toast 由 use-cash-balances 统一产出「已重算（自 YYYY-MM-DD 起）」（降级文案）。
 * - 成功后 invalidate：cash-balances / overview / nav / xirr / snapshots / holdings。
 *
 * 🔴 不新增审计表、不改 Prisma：变更历史 = 多行 `asOf` 列表（复用 `useCashBalances`）。
 */

import { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  Pencil,
  Trash2,
  Check,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { DateRangeQuickPicker } from '@/components/date/date-range-quick-picker';
import { resolveQuickRange } from '@/features/query/quick-range';
import { useDefaultDateRange } from '@/features/query/use-default-date-range';
import { useRangePreferenceSync } from '@/hooks/use-range-preference-sync';
import { usePortfolioBaseDate } from '@/stores/portfolio.store';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  useCashBalances,
  useDeleteCashBalance,
  useUpsertCashBalance,
} from '@/hooks/use-cash-balances';
import { usePreferenceStore } from '@/stores/preference.store';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { CashBalanceResponse } from '@/api/types';

/** 历史分页大小（CASH-P1-01） */
const HISTORY_PAGE_SIZE = 20;

export interface CashBalanceHistoryProps {
  portfolioId: string;
  className?: string;
}

export function CashBalanceHistory({
  portfolioId,
  className,
}: CashBalanceHistoryProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<CashBalanceResponse | null>(null);
  const [editAmount, setEditAmount] = useState('');
  const [editNote, setEditNote] = useState('');
  // 日期范围筛选（问题⑦）：空串 = 不限，不下发对应查询参数
  // I-04：默认日期范围 = 偏好（URL 无参数时），非法/空回落 '1y'
  // 「全部」快捷项的起点 = 组合首个交易日（问题②）
  const baseDate = usePortfolioBaseDate();
  const defaultRange = useDefaultDateRange();
  const defaultRangeValue = useMemo(
    () =>
      resolveQuickRange(defaultRange, {
        allRangeStart: baseDate ?? undefined,
      }),
    [defaultRange, baseDate],
  );
  const [filterStart, setFilterStart] = useState(defaultRangeValue.startDate);
  const [filterEnd, setFilterEnd] = useState(defaultRangeValue.endDate);
  // INC-01：快捷范围受控回显（空串 = 不限 / 自定义）
  const [filterQuick, setFilterQuick] = useState<string>(defaultRange);

  /**
   * 偏好对齐守卫（INC-01 决策 E · 统一范式）。
   *
   * 取代原先「defaultRangeValue 一变就无条件 setFilterStart/End」的 effect ——
   * 那会在用户手动改过范围后把选择弹回偏好默认值。本组件无 URL 载体，
   * 故 `urlParamKeys` 传空数组，跳过 URL 判定。
   */
  const { markInteracted } = useRangePreferenceSync({
    currentQuick: filterQuick,
    currentStartDate: filterStart,
    allRangeStart: baseDate,
    urlParamKeys: [],
    onAlign: (alignment) => {
      setFilterQuick(alignment.quick);
      setFilterStart(alignment.startDate);
      setFilterEnd(alignment.endDate);
      setPage(1);
    },
  });

  const getPreference = usePreferenceStore((s) => s.getPreference);
  const amountThousands = getPreference('amountThousands');
  const amountAbbrev = getPreference('amountAbbrev');
  const fmtOpts = { thousands: amountThousands, abbreviate: amountAbbrev };

  const { data, isLoading, isError } = useCashBalances(portfolioId, {
    page,
    pageSize: HISTORY_PAGE_SIZE,
    // 空串不下发，避免 queryKey 里出现无意义的 '' 造成多余缓存分片
    ...(filterStart ? { startDate: filterStart } : {}),
    ...(filterEnd ? { endDate: filterEnd } : {}),
  });
  const upsertMutation = useUpsertCashBalance();
  const deleteMutation = useDeleteCashBalance();

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));

  const startEdit = (row: CashBalanceResponse) => {
    setEditing(row);
    setEditAmount(row.amount);
    setEditNote(row.note ?? '');
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditAmount('');
    setEditNote('');
  };

  const saveEdit = () => {
    if (!editing) return;
    const amountNum = Number(editAmount);
    if (!Number.isFinite(amountNum) || amountNum < 0) return;
    upsertMutation.mutate(
      {
        portfolioId,
        payload: {
          asOf: editing.asOf,
          amount: amountNum,
          note: editNote || undefined,
        },
      },
      { onSettled: cancelEdit },
    );
  };

  const handleDelete = (row: CashBalanceResponse) => {
    deleteMutation.mutate({
      portfolioId,
      id: row.id,
      asOf: row.asOf,
    });
  };

  return (
    <div className={className}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs text-muted-foreground"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {open ? (
          <ChevronUp className="mr-1 h-3.5 w-3.5" />
        ) : (
          <ChevronDown className="mr-1 h-3.5 w-3.5" />
        )}
        查看变更历史
      </Button>

      {open && (
        <div className="mt-2 space-y-3">
          {/*
            问题⑦：变更历史支持日期范围 + 快捷范围筛选。
            筛选栏放在三态分支之外 —— 否则一旦筛出空结果就会连同筛选器一起
            被空态替换，用户无法改回条件（死锁）。
          */}
          <div className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3">
            <DateRangeQuickPicker
              quick={filterQuick}
              startDate={filterStart}
              endDate={filterEnd}
              allRangeStart={baseDate}
              onChange={(r) => {
                markInteracted();
                setFilterQuick(r.quick ?? '');
                setFilterStart(r.startDate);
                setFilterEnd(r.endDate);
                setPage(1); // 换范围后回到第 1 页，避免停留在越界页码
              }}
            />
            {(filterStart || filterEnd) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  markInteracted();
                  setFilterQuick('');
                  setFilterStart('');
                  setFilterEnd('');
                  setPage(1);
                }}
              >
                重置
              </Button>
            )}
          </div>

          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : isError ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              变更历史加载失败，请稍后重试
            </p>
          ) : items.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              {filterStart || filterEnd
                ? '所选日期范围内暂无现金余额变更记录'
                : '暂无现金余额变更记录'}
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[120px]">生效日</TableHead>
                      <TableHead className="text-right">金额</TableHead>
                      <TableHead>备注</TableHead>
                      <TableHead className="w-[110px]">更新时间</TableHead>
                      <TableHead className="w-[90px] text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((row) => {
                      const isEditing = editing?.id === row.id;
                      return (
                        <TableRow key={row.id}>
                          <TableCell className="font-mono text-sm whitespace-nowrap">
                            {formatDate(row.asOf)}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums whitespace-nowrap">
                            {isEditing ? (
                              <Input
                                type="number"
                                step="0.01"
                                min="0"
                                value={editAmount}
                                onChange={(e) => setEditAmount(e.target.value)}
                                className="ml-auto h-7 w-[130px] text-right"
                              />
                            ) : (
                              formatCurrency(row.amount, 2, fmtOpts)
                            )}
                          </TableCell>
                          <TableCell className="max-w-[180px]">
                            {isEditing ? (
                              <Input
                                value={editNote}
                                onChange={(e) => setEditNote(e.target.value)}
                                className="h-7"
                                placeholder="备注"
                              />
                            ) : (
                              <span className="truncate text-sm text-muted-foreground">
                                {row.note || '-'}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                            {formatDate(row.createdAt)}
                          </TableCell>
                          <TableCell className="text-right whitespace-nowrap">
                            {isEditing ? (
                              <div className="flex justify-end gap-0.5">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7"
                                  onClick={saveEdit}
                                  disabled={upsertMutation.isPending}
                                  title="保存"
                                >
                                  {upsertMutation.isPending ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <Check className="h-3.5 w-3.5" />
                                  )}
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7"
                                  onClick={cancelEdit}
                                  title="取消"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            ) : (
                              <div className="flex justify-end gap-0.5">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7"
                                  onClick={() => startEdit(row)}
                                  title="编辑（按生效日覆盖）"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7 text-red-500"
                                  onClick={() => handleDelete(row)}
                                  disabled={deleteMutation.isPending}
                                  title="删除"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {total > HISTORY_PAGE_SIZE && (
                <div className="flex items-center justify-between pt-2">
                  <span className="text-xs text-muted-foreground">
                    共 {total} 条 · 第 {page}/{totalPages} 页
                  </span>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={page <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                    >
                      上一页
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={page >= totalPages}
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    >
                      下一页
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
