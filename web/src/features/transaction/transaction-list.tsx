/**
 * features/transaction/transaction-list.tsx — 出入金（现金流）交易记录表格
 *
 * 数据来自后端 cashflow 接口，记录仅含 日期 / 类型 / 金额 / 备注（不包含标的、
 * 数量、单价、手续费——这些属于证券买卖 Trade，而非出入金）。支持编辑（弹出
 * Dialog）、删除（确认 AlertDialog）。
 */

import { useState } from 'react';
import { Pencil, Trash2, Loader2 } from 'lucide-react';
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
import { CashflowForm } from '@/features/cashflow/cashflow-form';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { TransactionQuery, TransactionResponse } from '@/api/types';
import { CashFlowType } from '@/lib/types';

export interface TransactionListProps {
  portfolioId: string;
  /** 列表查询参数 */
  query?: TransactionQuery;
  className?: string;
  /** 空状态时的提示文案 */
  emptyText?: string;
}

export function TransactionList({
  portfolioId,
  query,
  className,
  emptyText = '暂无交易记录',
}: TransactionListProps): JSX.Element {
  const { data, isLoading, isError } = useTransactions(portfolioId, query ?? {});
  const deleteMutation = useDeleteTransaction();
  const [editing, setEditing] = useState<TransactionResponse | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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
      ) : !data || data.items.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          {emptyText}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[100px]">日期</TableHead>
                <TableHead className="w-[60px]">类型</TableHead>
                <TableHead className="w-[100px] text-right">金额</TableHead>
                <TableHead className="w-[120px]">备注</TableHead>
                <TableHead className="w-[70px] text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((tx) => {
                const txResp = tx as unknown as TransactionResponse;
                return (
                  <TableRow key={txResp.id}>
                    <TableCell className="font-mono text-sm whitespace-nowrap">
                      {formatDate(txResp.date)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          txResp.type === CashFlowType.BUY ? 'secondary' : 'outline'
                        }
                        className={
                          txResp.type === CashFlowType.BUY
                            ? 'bg-up-soft text-up'
                            : 'bg-down-soft text-down'
                        }
                      >
                        {txResp.type === CashFlowType.BUY ? '存入' : '取出'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono whitespace-nowrap">
                      {formatCurrency(txResp.amount)}
                    </TableCell>
                    <TableCell className="max-w-[120px] truncate text-sm text-muted-foreground">
                      {txResp.note || '-'}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setEditing(txResp)}
                          title="编辑"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setDeletingId(txResp.id)}
                          title="删除"
                        >
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* 编辑对话框 */}
      <Dialog open={Boolean(editing)} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>编辑交易</DialogTitle>
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
            <AlertDialogTitle>确认删除该交易？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后，从该交易日期起的净值与 XIRR 将被批量重算。此操作不可撤销。
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
