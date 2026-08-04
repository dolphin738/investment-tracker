/**
 * features/snapshot/snapshot-list.tsx — 资产快照记录表格（PRD §7.3）
 *
 * 列：日期/总资产/持仓/现金/来源（🤖自动/✋手工）/系统自动值+差异/备注/操作。
 * 操作：
 * - ✎ 编辑（手工行 PATCH；自动行由页面以「变手工」方式打开）
 * - 🗑 删除（事件日会重新生成自动值）
 * - ↺ 重置（仅手工记录，恢复系统值）
 *
 * 列表层（SNAP-P0-04b / SNAP-P0-07 / §7.3）：
 * - 筛选行：日期范围 + 来源 checkbox（✓自动 ✓手工）+ [重置]
 * - 顶部差异提示条：「当前有 N 条手工记录，其中 M 条与自动值差异 > 1%」+ [仅看手工]
 * - 手工行差异列：系统自动计算值 + 差异金额 +（差异%）
 */

import { useEffect, useState } from 'react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import {
  computeManualDiffStats,
  formatAmountChange,
  formatCurrency,
  formatDate,
} from '@/lib/utils';
import type { SnapshotQuery } from '@/api/types';
import {
  SnapshotSource,
  type AssetSnapshot,
} from '@investment-tracker/shared';

export interface SnapshotListProps {
  portfolioId: string;
  query?: SnapshotQuery;
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

  // 筛选行本地状态（日期起止 + 来源 checkbox；「重置」清空）
  const [filterStart, setFilterStart] = useState('');
  const [filterEnd, setFilterEnd] = useState('');
  const [autoChecked, setAutoChecked] = useState(true);
  const [manualChecked, setManualChecked] = useState(true);

  // 筛选条件变化时回到第一页
  useEffect(() => {
    setPage(1);
  }, [filterStart, filterEnd, autoChecked, manualChecked]);

  // 来源筛选：两勾选相同（全选/全不选）= 不筛；仅自动 = DERIVED；仅手工 = MANUAL
  // F2 已获批：source 走服务端筛选（后端 DTO 落盘前联调注意先后顺序）
  const sourceQuery: SnapshotSource | undefined =
    autoChecked === manualChecked
      ? query?.source
      : autoChecked
        ? SnapshotSource.DERIVED
        : SnapshotSource.MANUAL;

  const { data, isLoading, isError } = useSnapshots(portfolioId, {
    ...query,
    startDate: filterStart || query?.startDate,
    endDate: filterEnd || query?.endDate,
    source: sourceQuery,
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

  // 系统自动计算值（date → 值）。近似：NAV×份额；待后端 derivedTotalAsset（F5，Part B-3）
  const systemValOf = (s: AssetSnapshot): number | null =>
    navMap ? (navMap.get(s.date) ?? null) : null;

  // 差异提示条统计（SNAP-P0-07 / F5）：以当前列表行为准（分页 20 条/页），
  // 系统值为 NAV×份额近似；全量/精确统计待后端 derivedTotalAsset。
  const manualStats = computeManualDiffStats(items, navMap);

  const resetFilters = () => {
    setFilterStart('');
    setFilterEnd('');
    setAutoChecked(true);
    setManualChecked(true);
    setPage(1);
  };

  /** [仅看手工] 切换：非手工过滤 → 仅手工；已仅手工 → 恢复全部 */
  const toggleManualOnly = () => {
    if (!autoChecked && manualChecked) {
      setAutoChecked(true);
      setManualChecked(true);
    } else {
      setAutoChecked(false);
      setManualChecked(true);
    }
  };

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

      {/* 差异提示条（SNAP-P0-07 ⑥） */}
      {manualStats.manualCount > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <span>
            ⚠️ 当前有 {manualStats.manualCount} 条手工记录，其中{' '}
            {manualStats.diffOverThresholdCount} 条与自动值差异 &gt; 1%
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            onClick={toggleManualOnly}
            title="筛选手工记录（再点一次恢复全部）"
          >
            {!autoChecked && manualChecked ? '显示全部' : '仅看手工'}
          </Button>
        </div>
      )}

      {/* 筛选行（SNAP-P0-04b 验收 2）：日期范围 + 来源 checkbox + [重置] */}
      <div className="mb-3 flex flex-wrap items-end gap-3 rounded-md border border-border p-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">起始日期</Label>
          <Input
            type="date"
            value={filterStart}
            onChange={(e) => setFilterStart(e.target.value)}
            className="w-[160px]"
          />
        </div>
        <span className="pb-2 text-muted-foreground">~</span>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">结束日期</Label>
          <Input
            type="date"
            value={filterEnd}
            onChange={(e) => setFilterEnd(e.target.value)}
            className="w-[160px]"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">来源</Label>
          <div className="flex items-center gap-4 pb-1">
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={autoChecked}
                onChange={(e) => setAutoChecked(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              🤖 自动
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={manualChecked}
                onChange={(e) => setManualChecked(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              ✋ 手工
            </label>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={resetFilters}>
          重置
        </Button>
      </div>

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
                // 近似：NAV×份额；待后端 derivedTotalAsset（F5）
                const systemVal = systemValOf(s);
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
                              （
                              {diffRate !== null
                                ? formatAmountChange(totalAssetNum, systemVal)
                                : '-'}
                              ）
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

      {/* 删除确认（🗑）（SNAP-P0-06 ⑤⑥：删除这条记录，事件日系统会重新生成自动值） */}
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

      {/* 重置确认（↺）（SNAP-P0-07：撤销手工修改，恢复系统计算值 + 将恢复值展示） */}
      <AlertDialog
        open={Boolean(resetting)}
        onOpenChange={(o) => !o && setResetting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>重置为系统自动计算值？</AlertDialogTitle>
            <AlertDialogDescription>
              {resetting ? (
                <>
                  {formatDate(resetting.date)} 的手工记录将被系统自动计算值取代，无法撤销。
                  {systemValOf(resetting) !== null && (
                    <>
                      {' '}
                      将恢复为系统自动计算值 ¥
                      {formatCurrency(systemValOf(resetting) as number)}。
                    </>
                  )}
                </>
              ) : (
                '手工记录将被系统自动计算值取代，无法撤销。'
              )}
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
