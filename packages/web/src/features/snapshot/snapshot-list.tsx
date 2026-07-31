/**
 * features/snapshot/snapshot-list.tsx — 快照记录表格
 */

import { useState } from 'react';
import { Trash2, Loader2 } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
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
import { useSnapshots, useDeleteSnapshot } from '@/hooks/use-snapshots';
import { formatCurrency, formatDate } from '@/lib/utils';

export interface SnapshotListProps {
  portfolioId: string;
  query?: { startDate?: string; endDate?: string; page?: number; pageSize?: number };
  className?: string;
  emptyText?: string;
}

export function SnapshotList({
  portfolioId,
  query,
  className,
  emptyText = '暂无快照记录',
}: SnapshotListProps): JSX.Element {
  const { data, isLoading, isError } = useSnapshots(portfolioId, query ?? {});
  const deleteMutation = useDeleteSnapshot();
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>日期</TableHead>
              <TableHead className="text-right">资产总额</TableHead>
              <TableHead>备注</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-mono text-sm">
                  {formatDate(s.date)}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatCurrency(s.totalAsset)}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {s.note || '-'}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setDeletingId(s.id)}
                    title="删除"
                  >
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <AlertDialog
        open={Boolean(deletingId)}
        onOpenChange={(o) => !o && setDeletingId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除该快照？</AlertDialogTitle>
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
