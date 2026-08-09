/**
 * features/security-income/dividend-fee-section.tsx — 分红记录区（HOLD-B-P0-10 + 增量 I-02）
 *
 * PRD §7.2【E】+ HOLD-B-P0-10 验收 2：
 * 「可在持仓模块按标的查看累计分红」
 *
 * 区块构成：
 * - 汇总卡：累计分红（净额）（§9.5 红涨绿跌：分红为收入=红）
 * - 按标的汇总表：标的 / 代码 / 累计分红（净额）（验收 2 的核心载体）
 * - [分红记录 ▾] 明细：日期/标的/类型/金额/所得税/净额/备注 + 编辑/删除（I-02 修复 tax/type）
 *
 * ⚠️ 净额口径（K-2）：累计分红 = Σ(amount − tax)，明细逐行展示 金额/所得税/净额。
 * ⚠️ 分红**不参与 XIRR 与净值计算**（D-02 / D-03），区块顶部固定展示该提示。
 * ⚠️ INC-04 物理并表：费用录入已并入「录入买卖」的费用三联字段，本区块不再展示费用，
 *   累计费用改由证券买卖流水（含费成本价）承载，故此处仅保留分红。
 */

import { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Coins,
  Info,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
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
import { EmptyState } from '@/components/EmptyState';
import {
  ENTRY_BUTTON_ICON_CLASS,
  ENTRY_BUTTON_SIZE,
  ENTRY_BUTTON_VARIANT,
} from '@/constants/entry-button-labels';
import { useDividends, useDeleteDividend } from '@/hooks/use-dividends';
import { usePreferenceStore } from '@/stores/preference.store';
import { formatCurrency, formatDate, cn } from '@/lib/utils';
import {
  DividendFeeForm,
  DIVIDEND_TYPE_LABEL,
} from './dividend-fee-form';
import type { DividendRecord } from '@/api/types';

/** 按标的聚合后的累计分红行 */
export interface SecurityIncomeRow {
  securityId: string;
  securityName: string;
  securityCode: string;
  /** 累计分红（净额口径，K-2） */
  dividendTotal: number;
}

/** 单条分红净额（税缺省按 0 处理，兼容存量数据） */
function netAmountOf(item: { amount: string; tax?: string | null }): number {
  return Number(item.amount) - Number(item.tax ?? 0) || 0;
}

/**
 * 按标的聚合累计分红（HOLD-B-P0-10 验收 2 + 增量 R-4）
 *
 * - 分红累计按**净额**（amount − tax）累加，与明细 Σ 口径一致
 * - 金额为 NUMERIC(18,2) 字符串，逐条 Number() 后累加
 * - 排序：累计分红降序 → 代码升序（保证渲染稳定）
 *
 * 导出以便单测直接覆盖聚合口径。
 */
export function aggregateBySecurity(
  dividends: DividendRecord[],
): SecurityIncomeRow[] {
  const map = new Map<string, SecurityIncomeRow>();

  const ensureRow = (
    securityId: string,
    securityName: string,
    securityCode: string,
  ): SecurityIncomeRow => {
    const existing = map.get(securityId);
    if (existing) return existing;
    const created: SecurityIncomeRow = {
      securityId,
      securityName,
      securityCode,
      dividendTotal: 0,
    };
    map.set(securityId, created);
    return created;
  };

  for (const item of dividends) {
    const row = ensureRow(item.securityId, item.securityName, item.securityCode);
    row.dividendTotal += netAmountOf(item);
  }

  return [...map.values()].sort(
    (a, b) =>
      b.dividendTotal - a.dividendTotal ||
      a.securityCode.localeCompare(b.securityCode),
  );
}

/** 分红净额求和（K-2：Σ(amount − tax)） */
export function sumNetAmount(
  records: Array<{ amount: string; tax?: string | null }>,
): number {
  return records.reduce((acc, r) => acc + netAmountOf(r), 0);
}

export interface DividendFeeSectionProps {
  portfolioId: string;
  className?: string;
  /** I-05 统一筛选器派生：证券多选（空 = 全部） */
  securityIds?: string[];
  /** 起始日期 YYYY-MM-DD（含） */
  startDate?: string;
  /** 结束日期 YYYY-MM-DD（含） */
  endDate?: string;
}

export function DividendFeeSection({
  portfolioId,
  className,
  securityIds = [],
  startDate,
  endDate,
}: DividendFeeSectionProps): JSX.Element {
  const securityIdParam = securityIds.length > 0 ? securityIds.join(',') : undefined;
  // 分红（I-05：标的多值 / 日期范围）
  const dividends = useDividends(portfolioId, {
    securityId: securityIdParam,
    startDate,
    endDate,
  });
  const deleteDividend = useDeleteDividend(portfolioId);

  const getPreference = usePreferenceStore((s) => s.getPreference);
  const amountThousands = getPreference('amountThousands');
  const amountAbbrev = getPreference('amountAbbrev');
  const moneyOpts = { thousands: amountThousands, abbreviate: amountAbbrev };

  // 录入弹窗（仅分红入口；编辑复用同一表单）
  const [formKind, setFormKind] = useState<'dividend' | null>(null);
  // 编辑态：被编辑的分红记录
  const [editing, setEditing] = useState<DividendRecord | null>(null);
  // 明细折叠状态（对应草图 [分红记录 ▾]）
  const [dividendOpen, setDividendOpen] = useState(false);
  // 删除确认
  const [deleting, setDeleting] = useState<string | null>(null);

  const dialogOpen = formKind !== null || editing !== null;
  const closeDialog = (): void => {
    setFormKind(null);
    setEditing(null);
  };

  const dividendList = useMemo(() => dividends.data ?? [], [dividends.data]);

  const rows = useMemo(
    () => aggregateBySecurity(dividendList),
    [dividendList],
  );
  const dividendTotal = useMemo(
    () => sumNetAmount(dividendList),
    [dividendList],
  );

  const isLoading = dividends.isLoading;
  const isError = dividends.isError;

  const handleConfirmDelete = async (): Promise<void> => {
    if (!deleting) return;
    await deleteDividend.mutateAsync(deleting);
    setDeleting(null);
  };

  const handleRetry = (): void => {
    void dividends.refetch();
  };

  return (
    <div className={cn('space-y-4', className)} data-testid="dividend-fee-section">
      {/* 区块标题 + 录入入口 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">分红记录</h3>
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <Info className="h-3 w-3" />
            独立记录，不参与 XIRR 与净值计算
          </p>
        </div>
        {/* INC-05：录入类入口统一为「主色 + sm + Plus」 */}
        <Button
          size={ENTRY_BUTTON_SIZE}
          variant={ENTRY_BUTTON_VARIANT}
          onClick={() => setFormKind('dividend')}
        >
          <Plus className={ENTRY_BUTTON_ICON_CLASS} />
          录入分红
        </Button>
      </div>

      {/* 加载态 */}
      {isLoading && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Skeleton className="h-[72px] w-full" />
            <Skeleton className="h-[72px] w-full" />
          </div>
          <Skeleton className="h-32 w-full" />
        </div>
      )}

      {/* 错误态 */}
      {!isLoading && isError && (
        <Card className="border-destructive/50">
          <CardContent className="flex flex-col items-center gap-4 py-8">
            <Coins className="h-8 w-8 text-destructive" />
            <p className="text-sm text-destructive">分红数据加载失败</p>
            <Button variant="outline" size="sm" onClick={handleRetry}>
              重新加载
            </Button>
          </CardContent>
        </Card>
      )}

      {!isLoading && !isError && (
        <>
          {/* 汇总卡：分红=收入=红（text-up）；分红按净额（K-2） */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Card>
              <CardContent className="py-3">
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Coins className="h-3.5 w-3.5" />
                  累计分红（净额）
                </p>
                <p
                  className="text-lg font-bold tabular-nums text-up"
                  data-testid="dividend-total"
                >
                  {formatCurrency(dividendTotal, 2, moneyOpts)}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* 空态 */}
          {rows.length === 0 && (
            <EmptyState
              icon={<Coins className="h-12 w-12" />}
              title="暂无分红记录"
              description="分红为独立记录，不影响收益计算；可按标的追溯累计金额"
              action={
                <Button
                  variant={ENTRY_BUTTON_VARIANT}
                  onClick={() => setFormKind('dividend')}
                >
                  <Plus className={ENTRY_BUTTON_ICON_CLASS} />
                  录入分红
                </Button>
              }
            />
          )}

          {/* 按标的汇总（HOLD-B-P0-10 验收 2；分红列按净额 K-2） */}
          {rows.length > 0 && (
            <Card>
              <div className="overflow-x-auto">
                <Table data-testid="income-summary-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>标的</TableHead>
                      <TableHead>代码</TableHead>
                      <TableHead className="text-right">累计分红（净额）</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.securityId}>
                        <TableCell className="font-medium">
                          {row.securityName}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {row.securityCode}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'text-right tabular-nums',
                            row.dividendTotal > 0 && 'text-up',
                          )}
                        >
                          {formatCurrency(row.dividendTotal, 2, moneyOpts)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Card>
          )}

          {/* [分红记录 ▾] 明细（增量 R-3：三列 金额/所得税/净额 + 编辑入口；I-02 tax/type 修复） */}
          <Card>
            <CardContent className="p-0">
              <button
                type="button"
                className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/50"
                onClick={() => setDividendOpen((v) => !v)}
                aria-expanded={dividendOpen}
              >
                <span className="flex items-center gap-2">
                  {dividendOpen ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                  分红记录
                  <Badge variant="secondary" className="text-xs">
                    {dividendList.length}
                  </Badge>
                </span>
              </button>

              {dividendOpen && (
                <div className="overflow-x-auto border-t">
                  {dividendList.length === 0 ? (
                    <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                      暂无分红记录
                    </p>
                  ) : (
                    <Table data-testid="dividend-detail-table">
                      <TableHeader>
                        <TableRow>
                          <TableHead>日期</TableHead>
                          <TableHead>标的</TableHead>
                          <TableHead>类型</TableHead>
                          <TableHead className="text-right">金额</TableHead>
                          <TableHead className="text-right">所得税</TableHead>
                          <TableHead className="text-right">净额</TableHead>
                          <TableHead>备注</TableHead>
                          <TableHead className="w-24 text-right">操作</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {dividendList.map((item) => (
                          <TableRow key={item.id}>
                            <TableCell className="tabular-nums">
                              {formatDate(item.date)}
                            </TableCell>
                            <TableCell>
                              {item.securityName}
                              <span className="ml-1 text-xs text-muted-foreground">
                                {item.securityCode}
                              </span>
                            </TableCell>
                            <TableCell>
                              <Badge variant="secondary" className="text-xs">
                                {DIVIDEND_TYPE_LABEL[item.type] ?? item.type}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-up">
                              {formatCurrency(item.amount, 2, moneyOpts)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">
                              {formatCurrency(item.tax ?? '0', 2, moneyOpts)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-up">
                              {formatCurrency(
                                Number(item.amount) - Number(item.tax ?? 0),
                                2,
                                moneyOpts,
                              )}
                            </TableCell>
                            <TableCell className="max-w-[200px] truncate text-muted-foreground">
                              {item.note ?? '-'}
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-0.5">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label="编辑分红记录"
                                  title="编辑"
                                  onClick={() => setEditing(item)}
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label="删除分红记录"
                                  title="删除"
                                  onClick={() => setDeleting(item.id)}
                                >
                                  <Trash2 className="h-4 w-4 text-destructive" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* 录入 / 编辑弹窗（仅分红） */}
      <Dialog open={dialogOpen} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? '编辑分红' : '录入分红'}</DialogTitle>
          </DialogHeader>
          {dialogOpen && (
            <DividendFeeForm
              key={editing ? `dividend-${editing.id}` : 'create'}
              portfolioId={portfolioId}
              record={editing}
              onSuccess={closeDialog}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除分红记录？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后不可恢复。该记录不参与收益计算，删除不会影响净值与 XIRR。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDelete}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
