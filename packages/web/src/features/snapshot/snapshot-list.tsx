/**
 * features/snapshot/snapshot-list.tsx — 资产快照记录表格（PRD §7.3）
 *
 * 列：日期/总资产/持仓/现金/来源（🤖自动/✋手工）/系统自动值+差异%/备注/操作。
 * 操作：
 * - ✎ 编辑（手工行 PATCH；自动行由页面以「变手工」方式打开）
 * - 🗑 删除（事件日会重新生成自动值）
 * - ↺ 重置（仅手工记录，恢复系统值）
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
import { useSnapshots, useDeleteSnapshot, useResetSnapshot } from '@/hooks/use-snapshots';
import { useNavTotalAssetMap } from '@/hooks/use-query-data';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { AssetSnapshot } from '@investment-tracker/shared';

export interface SnapshotListProps {
  portfolioId: string;
  query?: { startDate?: string; endDate?: string; page?: number; pageSize?: number };
  /** 点击编辑（页面打开 SnapshotForm 弹窗） */
  onEdit?: (item: AssetSnapshot) => void;
  /** 管理模式（来自 /snapshots?manage=1） */
  manageMode?: boolean;
  className?: string;
  emptyText?: string;
}

const PAGE_SIZE = 20;

export function SnapshotList({
  portfolioId,
  query,
  onEdit,
  manageMode = false,
  className,
  emptyText = '暂无资产记录',
}: SnapshotListProps): JSX.Element {
  const [page, setPage] = useState(1);
  const [deleting, setDeleting] = useState<AssetSnapshot | null>(null);
  const [resetting, setResetting] = useState<AssetSnapshot | null>(null);

  const { data, isLoading, isError } = useSnapshots(portfolioId, {
    ...query,
    page,
    pageSize: PAGE_SIZE,
  });
  const deleteMutation = useDeleteSnapshot();
  const resetMutation = useResetSnapshot();
  const navMapQuery = useNavTotalAssetMap(portfolioId);
  const navMap = navMapQuery.data;

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const isManual = (s: AssetSnapshot): boolean => s.source === 'MANUAL';

  const handleConfirmDelete = () => {
    if (deleting) {
      deleteMutation.mutate(
        { portfolioId, id: deleting.id },
        { onSettled: () => setDeleting(null) },
      );
    }
  };

  const handleConfirmReset = () => {
    if (resetting) {
      resetMutation.mutate(
        { portfolioId, date: resetting.date },
        { onSettled: () => setResetting(null) },
      );
    }
  };

  return (
    <div className={className}>
      {manageMode && (
        <div className="mb-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
          ⚙ 历史记录管理模式：可编辑 / 删除 / 重置快照记录。
        </div>
      )}

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
                <TableHead className="text-right">总资产</TableHead>
                <TableHead className="text-right">持仓</TableHead>
                <TableHead className="text-right">现金</TableHead>
                <TableHead className="w-[90px]">来源</TableHead>
                <TableHead>系统自动值（差异）</TableHead>
                <TableHead className="w-[110px]">备注</TableHead>
                <TableHead className="w-[110px] text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((s) => {
                const manual = isManual(s);
                const systemVal = navMap ? navMap.get(s.date) ?? null : null;
                const totalAssetNum = Number(s.totalAsset) || 0;
                const diffRate =
                  manual && systemVal !== null && systemVal !== 0
                    ? (totalAssetNum - systemVal) / systemVal
                    : null;
                return (
                  <TableRow key={s.id}>
                    <TableCell className="font-mono text-sm whitespace-nowrap">
                      {formatDate(s.date)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums whitespace-nowrap">
                      ¥{formatCurrency(s.totalAsset)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm whitespace-nowrap">
                      {s.marketValue !== null ? `¥${formatCurrency(s.marketValue)}` : '-'}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm whitespace-nowrap">
                      {s.cashBalance !== null ? `¥${formatCurrency(s.cashBalance)}` : '-'}
                    </TableCell>
                    <TableCell>
                      {manual ? (
                        <Badge variant="secondary" className="bg-up-soft text-up">
                          ✋ 手工
                        </Badge>
                      ) : (
                        <Badge variant="outline">🤖 自动</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {manual ? (
                        systemVal !== null ? (
                          <span className="text-muted-foreground">
                            系统 ¥{formatCurrency(systemVal)}
                            <span
                              className={
                                diffRate !== null && diffRate >= 0
                                  ? 'ml-1 text-up'
                                  : 'ml-1 text-down'
                              }
                            >
                              （{diffRate !== null ? `${(diffRate * 100).toFixed(2)}%` : '-'}）
                            </span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          系统计算
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[100px] truncate text-sm text-muted-foreground">
                      {s.note || '-'}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <div className="flex justify-end gap-0.5">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => onEdit?.(s)}
                          title="编辑（变手工）"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        {manual && (
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => setResetting(s)}
                            title="重置为系统自动值"
                          >
                            <RotateCcw className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setDeleting(s)}
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

      {/* 删除确认（🗑） */}
      <AlertDialog
        open={Boolean(deleting)}
        onOpenChange={(o) => !o && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除该条资产记录？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后，若该日为事件日（有交易/余额/价格数据）将自动重新生成系统计算值；
              否则该日记录将被移除，并从该日期起的净值与 XIRR 将被重算。
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

      {/* 重置确认（↺） */}
      <AlertDialog
        open={Boolean(resetting)}
        onOpenChange={(o) => !o && setResetting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>重置为系统自动计算值？</AlertDialogTitle>
            <AlertDialogDescription>
              {resetting
                ? `${formatDate(resetting.date)} 的手工记录将被系统自动计算值取代，无法撤销。`
                : '手工记录将被系统自动计算值取代，无法撤销。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetMutation.isPending}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmReset}
              disabled={resetMutation.isPending}
            >
              {resetMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              确认重置
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
