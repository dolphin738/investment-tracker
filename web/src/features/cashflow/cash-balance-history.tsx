/**
 * features/cashflow/cash-balance-history.tsx — 现金余额变更历史表格（CASH-P1-01 / AL-046）
 *
 * 出入金页改版后的定位：作为「现金余额」页签的**主列表**（不再是折叠器），
 * 版式对齐持仓页「买卖明细」——上方当前余额、下方变更历史。
 *
 * - 日期范围**受控**：由页面顶部统一筛选器下发（本组件不再自绘筛选栏），
 *   与「出入金流水」共用同一份日期条件。范围变化时自动回到第 1 页。
 * - 按 `asOf` 倒序分页列出（生效日 / 金额 / 备注 / 更新时间），pageSize 20。
 * - 每行可**编辑**（交回父级用统一录入弹窗承载，新增/编辑复用同一表单）
 *   与**删除**（二次确认；删除触发后端 recalculateRange 级联重算）。
 * - 删除成功 toast 由 use-cash-balances 统一产出「已重算（自 YYYY-MM-DD 起）」；
 *   删除失败则**保持确认框打开并就地显示原因**（不吞错误，不重复 toast）。
 * - 成功后 invalidate：cash-balances / overview / nav / xirr / snapshots / holdings
 *   （由 useDeleteCashBalance 统一处理，列表随之自动刷新）。
 *
 * 🔴 不新增审计表：变更历史 = 多行 `asOf` 列表（复用 `useCashBalances`）。
 */

import { useEffect, useState } from 'react';
import { AlertCircle, Loader2, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useCashBalances, useDeleteCashBalance } from '@/hooks/use-cash-balances';
import { usePreferenceStore } from '@/stores/preference.store';
import { resolveApiErrorMessage } from '@/lib/api-error-message';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { CashBalanceResponse } from '@/api/types';

/** 历史分页大小（CASH-P1-01） */
const HISTORY_PAGE_SIZE = 20;

export interface CashBalanceHistoryProps {
  portfolioId: string;
  /** 受控日期范围起点（来自页面统一筛选器；空串 = 不限） */
  startDate?: string;
  /** 受控日期范围终点（来自页面统一筛选器；空串 = 不限） */
  endDate?: string;
  /**
   * 点击「编辑」回调 —— 由父级用统一录入弹窗承载。
   * 不传则不渲染编辑按钮（保持组件在只读场景下可复用）。
   */
  onEdit?: (row: CashBalanceResponse) => void;
  /** 空态「清除筛选」回调（存在日期条件时显示） */
  onClearFilter?: () => void;
  className?: string;
}

export function CashBalanceHistory({
  portfolioId,
  startDate = '',
  endDate = '',
  onEdit,
  onClearFilter,
  className,
}: CashBalanceHistoryProps): JSX.Element {
  const [page, setPage] = useState(1);
  const [deleting, setDeleting] = useState<CashBalanceResponse | null>(null);
  const [deleteError, setDeleteError] = useState('');

  // 统一筛选器换范围后回到第 1 页，避免停留在越界页码看到空表
  useEffect(() => {
    setPage(1);
  }, [startDate, endDate]);

  const getPreference = usePreferenceStore((s) => s.getPreference);
  const amountThousands = getPreference('amountThousands');
  const amountAbbrev = getPreference('amountAbbrev');
  const fmtOpts = { thousands: amountThousands, abbreviate: amountAbbrev };

  const { data, isLoading, isError } = useCashBalances(portfolioId, {
    page,
    pageSize: HISTORY_PAGE_SIZE,
    // 空串不下发，避免 queryKey 里出现无意义的 '' 造成多余缓存分片
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
  });
  const deleteMutation = useDeleteCashBalance();

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
  const hasDateFilter = Boolean(startDate || endDate);

  const requestDelete = (row: CashBalanceResponse): void => {
    setDeleteError('');
    setDeleting(row);
  };

  const handleConfirmDelete = (): void => {
    if (!deleting) return;
    setDeleteError('');
    deleteMutation.mutate(
      { portfolioId, id: deleting.id, asOf: deleting.asOf },
      {
        // 成功才关闭确认框；失败保留并就地说明原因（不吞错误）
        onSuccess: () => setDeleting(null),
        onError: (error) => {
          setDeleteError(
            resolveApiErrorMessage(error, '现金余额记录删除失败，请稍后重试'),
          );
        },
      },
    );
  };

  return (
    <div className={className}>
      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : isError ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          变更历史加载失败，请稍后重试
        </p>
      ) : items.length === 0 ? (
        <div className="space-y-2 py-6 text-center">
          <p className="text-xs text-muted-foreground">
            {hasDateFilter
              ? '所选日期范围内暂无现金余额变更记录'
              : '暂无现金余额变更记录'}
          </p>
          {hasDateFilter && onClearFilter && (
            <Button size="sm" variant="outline" onClick={onClearFilter}>
              清除筛选
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
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
                {items.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap font-mono text-sm">
                      {formatDate(row.asOf)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono tabular-nums">
                      {formatCurrency(row.amount, 2, fmtOpts)}
                    </TableCell>
                    <TableCell className="max-w-[180px]">
                      <span className="truncate text-sm text-muted-foreground">
                        {row.note || '-'}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDate(row.createdAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <div className="flex justify-end gap-0.5">
                        {onEdit && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() => onEdit(row)}
                            title="编辑（按生效日覆盖）"
                            aria-label={`编辑 ${row.asOf} 的现金余额`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-red-500"
                          onClick={() => requestDelete(row)}
                          title="删除"
                          aria-label={`删除 ${row.asOf} 的现金余额`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
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
        </div>
      )}

      {/* 删除二次确认（与出入金流水删除同一范式） */}
      <AlertDialog
        open={Boolean(deleting)}
        onOpenChange={(o) => {
          if (!o) {
            setDeleting(null);
            setDeleteError('');
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除该条现金余额记录？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后，从该生效日起的净值与 XIRR 将被批量重算。此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <p
              role="alert"
              className="flex items-start gap-1.5 rounded-md bg-red-50 p-2 text-xs text-red-600 dark:bg-red-950/30"
            >
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{deleteError}</span>
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // 失败时需要保留确认框，故阻止 Radix 默认关闭行为
                e.preventDefault();
                handleConfirmDelete();
              }}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
