/**
 * features/cashflow/cashflow-list.tsx — 出入金流水表格
 *
 * PRD §7.1【C】：表格（日期/类型/金额/备注/操作✎🗑）+ 分页（20/50/100）。
 * 类型筛选由后端按 types 参数过滤（F2 已获批，Part E-1 多选语义），
 * 前端只透传筛选条件，不再对当前页数据做过滤。
 * 分页为受控组件：page/pageSize 由父页面持有（URL query，FLOW-P0-02 验收2）。
 */

import { useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Pencil,
  RotateCcw,
  Trash2,
  Loader2,
} from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { Skeleton } from '@/components/ui/skeleton';
import { useTransactions, useDeleteTransaction } from '@/hooks/use-transactions';
import { CashflowForm } from './cashflow-form';
import { PAGE_SIZE_OPTIONS } from './query-params';
import { formatCurrency, formatDate, cn } from '@/lib/utils';
import type { TransactionQuery, TransactionResponse } from '@/api/types';
import { CashFlowType } from '@investment-tracker/shared';

export interface CashflowListProps {
  portfolioId: string;
  /** 查询参数（日期范围/排序等，不含 page/pageSize/types） */
  query?: TransactionQuery;
  /** 类型多选（空数组 = 全部；F2 已获批透传 types，Part E-1 语义） */
  types?: Array<'BUY' | 'SELL'>;
  /** 当前页码（受控，URL query 持有） */
  page: number;
  /** 每页条数（受控，20/50/100，URL query 持有） */
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  /** 空态「清除筛选」回调（存在非默认筛选条件时显示） */
  onClearFilter?: () => void;
  className?: string;
  emptyText?: string;
}

export function CashflowList({
  portfolioId,
  query,
  types = [],
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  onClearFilter,
  className,
  emptyText = '暂无出入金记录',
}: CashflowListProps): JSX.Element {
  const [editing, setEditing] = useState<TransactionResponse | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const { data, isLoading, isError } = useTransactions(portfolioId, {
    ...query,
    ...(types.length > 0 ? { types } : {}),
    page,
    pageSize,
  });
  const deleteMutation = useDeleteTransaction();

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  /** 是否存在非默认筛选条件（决定空态是否展示「清除筛选」按钮） */
  const hasActiveFilters =
    types.length > 0 ||
    Boolean(query?.startDate) ||
    Boolean(query?.endDate) ||
    query?.sortBy === 'amount' ||
    query?.sortOrder === 'asc' ||
    page > 1;

  const handleConfirmDelete = () => {
    if (deletingId) {
      deleteMutation.mutate(
        { portfolioId, id: deletingId },
        { onSettled: () => setDeletingId(null) },
      );
    }
  };

  return (
    <div className={className}>
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : isError ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          加载失败，请稍后重试
        </div>
      ) : items.length === 0 ? (
        // FLOW-P0-02 验收5：空态 + 「清除筛选」按钮（有非默认筛选条件时）
        <div className="py-10 text-center">
          <p className="text-sm text-muted-foreground">{emptyText}</p>
          {hasActiveFilters && onClearFilter && (
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={onClearFilter}
            >
              <RotateCcw className="mr-1 h-3.5 w-3.5" />
              清除筛选
            </Button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[110px]">日期</TableHead>
                <TableHead className="w-[70px]">类型</TableHead>
                <TableHead className="text-right">金额</TableHead>
                <TableHead>备注</TableHead>
                <TableHead className="w-[80px] text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((tx) => (
                <TableRow key={tx.id}>
                  <TableCell className="font-mono text-sm whitespace-nowrap">
                    {formatDate(tx.date)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        tx.type === CashFlowType.BUY ? 'secondary' : 'outline'
                      }
                      className={cn(
                        tx.type === CashFlowType.BUY
                          ? 'bg-up-soft text-up'
                          : 'bg-down-soft text-down',
                      )}
                    >
                      {tx.type === CashFlowType.BUY ? '存入' : '取出'}
                    </Badge>
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right font-mono tabular-nums whitespace-nowrap',
                      tx.type === CashFlowType.BUY ? 'text-up' : 'text-down',
                    )}
                  >
                    {tx.type === CashFlowType.BUY ? '+' : '-'}
                    {formatCurrency(tx.amount)}
                  </TableCell>
                  <TableCell className="max-w-[180px] truncate text-sm text-muted-foreground">
                    {tx.note || '-'}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setEditing(tx)}
                        title="编辑"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setDeletingId(tx.id)}
                        title="删除"
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* 分页：页码 + 每页条数（20/50/100）+ 上/下一页 */}
      {!isLoading && !isError && total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              共 {total} 条 · 第 {page}/{totalPages} 页
            </span>
            <Select
              value={String(pageSize)}
              onValueChange={(v) => onPageSizeChange(Number(v))}
            >
              <SelectTrigger className="h-8 w-[92px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((opt) => (
                  <SelectItem key={opt} value={String(opt)}>
                    {opt} / 页
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1}
              onClick={() => onPageChange(page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
              上一页
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= totalPages}
              onClick={() => onPageChange(page + 1)}
            >
              下一页
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* 编辑弹窗 */}
      <Dialog open={Boolean(editing)} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>编辑出入金</DialogTitle>
          </DialogHeader>
          {editing && (
            <CashflowForm
              portfolioId={portfolioId}
              cashflow={editing}
              onSuccess={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <AlertDialog
        open={Boolean(deletingId)}
        onOpenChange={(o) => !o && setDeletingId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除该笔出入金？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后，从该日期起的净值与 XIRR 将被批量重算。此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
