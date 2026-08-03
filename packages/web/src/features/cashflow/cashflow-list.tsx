/**
 * features/cashflow/cashflow-list.tsx — 出入金流水表格
 *
 * PRD §7.1【C】：表格（日期/类型/金额/备注/操作✎🗑）+ 分页。
 * 类型筛选在后端暂不支持（CashFlowQueryDto 无 type 字段），
 * 故「类型筛选」在当前页数据上做前端过滤。
 */

import { useState } from 'react';
import { ChevronLeft, ChevronRight, Pencil, Trash2, Loader2 } from 'lucide-react';
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
import { formatCurrency, formatDate, cn } from '@/lib/utils';
import type { TransactionQuery, TransactionResponse } from '@/api/types';
import { CashFlowType } from '@investment-tracker/shared';

export interface CashflowListProps {
  portfolioId: string;
  /** 查询参数（日期范围等，不含分页页码） */
  query?: TransactionQuery;
  /** 当前页类型过滤（'all' 表示全部；后端不支持 type 参数，前端过滤） */
  typeFilter?: string;
  className?: string;
  emptyText?: string;
}

const PAGE_SIZE = 20;

export function CashflowList({
  portfolioId,
  query,
  typeFilter = 'all',
  className,
  emptyText = '暂无出入金记录',
}: CashflowListProps): JSX.Element {
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<TransactionResponse | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const { data, isLoading, isError } = useTransactions(portfolioId, {
    ...query,
    page,
    pageSize: PAGE_SIZE,
  });
  const deleteMutation = useDeleteTransaction();

  const rawItems = data?.items ?? [];
  const items =
    typeFilter === 'all'
      ? rawItems
      : rawItems.filter((tx) => tx.type === typeFilter);
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
        <div className="py-10 text-center text-sm text-muted-foreground">
          {emptyText}
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
                    {tx.type === CashFlowType.BUY ? '+' : '-'}¥
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

      {/* 分页 */}
      {!isLoading && !isError && total > PAGE_SIZE && (
        <div className="flex items-center justify-between pt-3">
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
              <ChevronLeft className="h-4 w-4" />
              上一页
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
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
