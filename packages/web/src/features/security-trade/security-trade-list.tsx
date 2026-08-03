/**
 * features/security-trade/security-trade-list.tsx — 证券买卖明细流水表格
 *
 * PRD §7.2【C】：列表 + 筛选（标的/日期/方向）+ 编辑/删除。
 * 交易响应不含标的名称，由 securities 列表映射展示。
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
import { useSecurityTrades, useDeleteSecurityTrade } from '@/hooks/use-security-trades';
import { useSecurities } from '@/hooks/use-securities';
import { SecurityTradeForm } from './security-trade-form';
import { formatCurrency, formatDate } from '@/lib/utils';
import { SecuritySide } from '@investment-tracker/shared';
import type {
  SecurityTradeQuery,
  SecurityTradeResponse,
} from '@/api/types';

export interface SecurityTradeListProps {
  portfolioId: string;
  /** 查询参数（标的/日期范围；分页在组件内维护） */
  query?: SecurityTradeQuery;
  /** 方向筛选（'all' | 'BUY_SEC' | 'SELL_SEC'；后端按 side 参数过滤） */
  sideFilter?: string;
  className?: string;
  emptyText?: string;
}

const PAGE_SIZE = 20;

export function SecurityTradeList({
  portfolioId,
  query,
  sideFilter = 'all',
  className,
  emptyText = '暂无买卖流水',
}: SecurityTradeListProps): JSX.Element {
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<SecurityTradeResponse | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const { data, isLoading, isError } = useSecurityTrades(portfolioId, {
    ...query,
    ...(sideFilter !== 'all' ? { side: sideFilter as SecuritySide } : {}),
    page,
    pageSize: PAGE_SIZE,
  });
  const deleteMutation = useDeleteSecurityTrade();
  const { data: securities = [] } = useSecurities(portfolioId);

  const securityMap = new Map(securities.map((s) => [s.id, s]));
  const items = data?.items ?? [];
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
                <TableHead className="w-[100px]">日期</TableHead>
                <TableHead className="w-[60px]">方向</TableHead>
                <TableHead>标的</TableHead>
                <TableHead className="text-right">数量</TableHead>
                <TableHead className="text-right">单价</TableHead>
                <TableHead className="text-right">费用</TableHead>
                <TableHead className="text-right">成交额</TableHead>
                <TableHead className="w-[100px]">备注</TableHead>
                <TableHead className="w-[80px] text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((t) => {
                const sec = securityMap.get(t.securityId);
                const qty = Number(t.quantity);
                const price = Number(t.price);
                const fee = Number(t.fee);
                const amount =
                  t.side === SecuritySide.BUY_SEC
                    ? qty * price + fee
                    : qty * price - fee;
                return (
                  <TableRow key={t.id}>
                    <TableCell className="font-mono text-sm whitespace-nowrap">
                      {formatDate(t.date)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          t.side === SecuritySide.BUY_SEC
                            ? 'secondary'
                            : 'outline'
                        }
                        className={
                          t.side === SecuritySide.BUY_SEC
                            ? 'bg-up-soft text-up'
                            : 'bg-down-soft text-down'
                        }
                      >
                        {t.side === SecuritySide.BUY_SEC ? '买入' : '卖出'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">
                      {sec ? (
                        <span>
                          {sec.name}
                          <span className="ml-1 text-xs text-muted-foreground">
                            {sec.code}
                          </span>
                        </span>
                      ) : (
                        '-'
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm whitespace-nowrap">
                      {Number(t.quantity).toLocaleString('zh-CN', {
                        maximumFractionDigits: 4,
                      })}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm whitespace-nowrap">
                      {formatCurrency(t.price)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm whitespace-nowrap">
                      {formatCurrency(t.fee)}
                    </TableCell>
                    <TableCell className="text-right font-mono whitespace-nowrap">
                      {formatCurrency(amount)}
                    </TableCell>
                    <TableCell className="max-w-[110px] truncate text-sm text-muted-foreground">
                      {t.note || '-'}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setEditing(t)}
                          title="编辑"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setDeletingId(t.id)}
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
            <DialogTitle>编辑买卖流水</DialogTitle>
          </DialogHeader>
          {editing && (
            <SecurityTradeForm
              portfolioId={portfolioId}
              trade={editing}
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
            <AlertDialogTitle>确认删除该笔买卖流水？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后持仓将重新推导，并从该日期起的净值与 XIRR 将被重算。此操作不可撤销。
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
