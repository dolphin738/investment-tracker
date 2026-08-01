/**
 * pages/HoldingsPage.tsx — 持仓管理页
 *
 * 功能：
 * - 持仓列表（表格）：标的名称/代码、数量、均价、市值、盈亏、盈亏%、占比
 * - 顶部汇总行：总市值、总成本、总盈亏
 * - 操作：新增/编辑/删除持仓
 * - 点击行弹出持仓详情（分红记录、费用记录）
 * - 暂无持仓时显示引导空态
 * - 加载态 / 空态 / 错误态
 */

import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  PackageOpen,
  AlertTriangle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LoadingSpinner, TableSkeleton } from '@/components/LoadingSpinner';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { usePortfolios } from '@/hooks/use-portfolios';
import {
  useHoldings,
  useHoldingDates,
  useUpsertHolding,
  useDeleteHolding,
  useSyncHoldingToSnapshot,
} from '@/hooks/use-holdings';
import { useSecurities, useCreateSecurity } from '@/hooks/use-securities';
import { useQuery } from '@tanstack/react-query';
import { listDividends } from '@/api/dividend.api';
import { listFees } from '@/api/fee.api';
import {
  SecurityType,
  DividendType,
  FeeType,
  type HoldingResponse,
  type Security,
} from '@investment-tracker/shared';
import { formatCurrency, formatPercent, formatDate } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { ROUTE_PATH } from '@/lib/constants';

// ===== 常量 =====
const SECURITY_TYPE_LABEL: Record<string, string> = {
  STOCK: '股票',
  FUND: '基金',
  BOND: '债券',
  CASH: '现金',
  OTHER: '其他',
};

const DIVIDEND_TYPE_LABEL: Record<string, string> = {
  CASH: '现金分红',
  STOCK_DIVIDEND: '红利再投',
};

const FEE_TYPE_LABEL: Record<string, string> = {
  COMMISSION: '佣金',
  STAMP_TAX: '印花税',
  OTHER: '其他',
};

// ===== 持仓表单组件 =====
interface HoldingFormData {
  securityId: string;
  date: string;
  quantity: string;
  avgCost: string;
  marketPrice: string;
  note: string;
}

const EMPTY_FORM: HoldingFormData = {
  securityId: '',
  date: new Date().toISOString().slice(0, 10),
  quantity: '',
  avgCost: '',
  marketPrice: '',
  note: '',
};

function HoldingFormDialog({
  open,
  onOpenChange,
  portfolioId,
  securities,
  editData,
  onSave,
  saving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  portfolioId: string;
  securities: Security[];
  editData?: HoldingResponse | null;
  onSave: (data: HoldingFormData) => void;
  saving: boolean;
}): JSX.Element {
  const [form, setForm] = useState<HoldingFormData>(EMPTY_FORM);
  const [showNewSecurity, setShowNewSecurity] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<string>('STOCK');

  const createSecurity = useCreateSecurity(portfolioId);

  // 编辑模式回填
  useEffect(() => {
    if (open) {
      if (editData) {
        setForm({
          securityId: editData.securityId,
          date: editData.date,
          quantity: editData.quantity,
          avgCost: editData.avgCost,
          marketPrice: editData.marketPrice,
          note: editData.note ?? '',
        });
      } else {
        setForm(EMPTY_FORM);
        setShowNewSecurity(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editData?.id]);

  // sync form when opening
  const isEdit = Boolean(editData);
  const derived = useMemo(() => {
    const q = parseFloat(form.quantity) || 0;
    const ac = parseFloat(form.avgCost) || 0;
    const mp = parseFloat(form.marketPrice) || 0;
    return {
      costAmount: q * ac,
      marketValue: q * mp,
      profit: q * mp - q * ac,
    };
  }, [form.quantity, form.avgCost, form.marketPrice]);

  function handleSubmit(): void {
    if (!form.securityId && !showNewSecurity) return;
    if (!form.date || !form.quantity || !form.avgCost || !form.marketPrice) return;

    if (showNewSecurity) {
      createSecurity.mutate(
        { code: newCode, name: newName, type: newType as SecurityType },
        {
          onSuccess: (sec) => {
            onSave({ ...form, securityId: sec.id });
          },
        },
      );
    } else {
      onSave(form);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑持仓' : '新增持仓'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? '修改持仓的数量、成本或现价'
              : '录入持仓的数量、成本价和现价'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {/* 标的 */}
          {!showNewSecurity ? (
            <div className="space-y-2">
              <Label>标的</Label>
              <div className="flex gap-2">
                <Select
                  value={form.securityId}
                  onValueChange={(v) => setForm((p) => ({ ...p, securityId: v }))}
                  disabled={isEdit}
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="选择标的" />
                  </SelectTrigger>
                  <SelectContent>
                    {securities.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name} ({s.code})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!isEdit && (
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setShowNewSecurity(true)}
                    title="新建标的"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3 rounded-lg border p-3">
              <p className="text-sm font-medium">新建标的</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">代码</Label>
                  <Input
                    value={newCode}
                    onChange={(e) => setNewCode(e.target.value)}
                    placeholder="如 600519"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">名称</Label>
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="如 贵州茅台"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Select value={newType} onValueChange={setNewType}>
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(SECURITY_TYPE_LABEL).map(([k, v]) => (
                      <SelectItem key={k} value={k}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowNewSecurity(false)}
                >
                  取消
                </Button>
              </div>
            </div>
          )}

          {/* 日期 */}
          <div className="space-y-2">
            <Label>日期</Label>
            <Input
              type="date"
              value={form.date}
              onChange={(e) => setForm((p) => ({ ...p, date: e.target.value }))}
              max={new Date().toISOString().slice(0, 10)}
            />
          </div>

          {/* 数量 + 成本价 */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>数量</Label>
              <Input
                type="number"
                step="0.000001"
                min="0"
                value={form.quantity}
                onChange={(e) => setForm((p) => ({ ...p, quantity: e.target.value }))}
                placeholder="0"
              />
            </div>
            <div className="space-y-2">
              <Label>成本价</Label>
              <Input
                type="number"
                step="0.000001"
                min="0"
                value={form.avgCost}
                onChange={(e) => setForm((p) => ({ ...p, avgCost: e.target.value }))}
                placeholder="0.00"
              />
            </div>
          </div>

          {/* 现价 */}
          <div className="space-y-2">
            <Label>现价</Label>
            <Input
              type="number"
              step="0.000001"
              min="0"
              value={form.marketPrice}
              onChange={(e) =>
                setForm((p) => ({ ...p, marketPrice: e.target.value }))
              }
              placeholder="0.00"
            />
          </div>

          {/* 派生预览 */}
          {derived.marketValue > 0 && (
            <div className="rounded-lg bg-muted/50 p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">成本额</span>
                <span>¥{formatCurrency(derived.costAmount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">市值</span>
                <span>¥{formatCurrency(derived.marketValue)}</span>
              </div>
              <div className="flex justify-between font-medium">
                <span className="text-muted-foreground">浮动盈亏</span>
                <span
                  className={cn(
                    derived.profit >= 0
                      ? 'text-red-600'
                      : 'text-emerald-600',
                  )}
                >
                  {derived.profit >= 0 ? '+' : ''}
                  ¥{formatCurrency(Math.abs(derived.profit))}
                </span>
              </div>
            </div>
          )}

          {/* 备注 */}
          <div className="space-y-2">
            <Label>备注</Label>
            <Input
              value={form.note}
              onChange={(e) => setForm((p) => ({ ...p, note: e.target.value }))}
              placeholder="选填"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={
              saving ||
              (!form.securityId && !showNewSecurity) ||
              !form.quantity ||
              !form.avgCost ||
              !form.marketPrice
            }
          >
            {saving ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ===== 持仓详情（分红+费用） =====
function HoldingDetailPanel({
  holding,
  portfolioId,
}: {
  holding: HoldingResponse;
  portfolioId: string;
}): JSX.Element {
  const dividends = useQuery({
    queryKey: ['dividends', 'list', portfolioId],
    queryFn: () => listDividends(portfolioId),
    enabled: Boolean(portfolioId),
  });
  const fees = useQuery({
    queryKey: ['fees', 'list', portfolioId],
    queryFn: () => listFees(portfolioId),
    enabled: Boolean(portfolioId),
  });

  const relatedDividends = (dividends.data ?? []).filter(
    (d) => d.securityId === holding.securityId,
  );
  const relatedFees = (fees.data ?? []).filter(
    (f) => f.securityId === holding.securityId,
  );

  return (
    <div className="space-y-4 border-t pt-4">
      <Tabs defaultValue="dividends">
        <TabsList>
          <TabsTrigger value="dividends">
            分红记录 ({relatedDividends.length})
          </TabsTrigger>
          <TabsTrigger value="fees">
            费用记录 ({relatedFees.length})
          </TabsTrigger>
        </TabsList>
        <div className="mt-3">
          {/* 分红 */}
          <div className="space-y-2">
            {dividends.isLoading ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                加载中…
              </p>
            ) : relatedDividends.length > 0 ? (
              relatedDividends.map((d) => (
                <div
                  key={d.id}
                  className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2 text-sm"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-muted-foreground">
                      {formatDate(d.date, 'yyyy-MM-dd')}
                    </span>
                    <Badge variant="outline" className="text-xs">
                      {DIVIDEND_TYPE_LABEL[d.type] || d.type}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-medium tabular-nums">
                      ¥{formatCurrency(d.amount)}
                    </span>
                    {d.note && (
                      <span className="max-w-[100px] truncate text-xs text-muted-foreground">
                        {d.note}
                      </span>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <p className="py-4 text-center text-sm text-muted-foreground">
                暂无分红记录
              </p>
            )}
          </div>

          {/* 费用 */}
          <div className="mt-4 space-y-2">
            <h4 className="text-sm font-medium text-muted-foreground">
              费用记录
            </h4>
            {fees.isLoading ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                加载中…
              </p>
            ) : relatedFees.length > 0 ? (
              relatedFees.map((f) => (
                <div
                  key={f.id}
                  className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2 text-sm"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-muted-foreground">
                      {formatDate(f.date, 'yyyy-MM-dd')}
                    </span>
                    <Badge variant="outline" className="text-xs">
                      {FEE_TYPE_LABEL[f.type] || f.type}
                    </Badge>
                  </div>
                  <span className="font-medium tabular-nums">
                    ¥{formatCurrency(f.amount)}
                  </span>
                </div>
              ))
            ) : (
              <p className="py-4 text-center text-sm text-muted-foreground">
                暂无费用记录
              </p>
            )}
          </div>
        </div>
      </Tabs>
    </div>
  );
}

// ===== 主页面 =====
export default function HoldingsPage(): JSX.Element {
  const navigate = useNavigate();
  const currentPortfolioId = usePortfolioStore((s) => s.currentPortfolioId);
  const { data: portfolios = [], isLoading: portfoliosLoading } = usePortfolios();

  // 筛选状态
  const [selectedDate, setSelectedDate] = useState<string>(
    new Date().toISOString().slice(0, 10),
  );
  const [typeFilter, setTypeFilter] = useState<string>('ALL');

  // 表单状态
  const [formOpen, setFormOpen] = useState(false);
  const [editHolding, setEditHolding] = useState<HoldingResponse | null>(null);

  // 删除确认
  const [deleteId, setDeleteId] = useState<string | null>(null);

  // 展开行
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // 数据查询
  const holdings = useHoldings(currentPortfolioId, {
    date: selectedDate,
    types: typeFilter !== 'ALL' ? [typeFilter as SecurityType] : undefined,
  });
  const dates = useHoldingDates(currentPortfolioId);
  const securities = useSecurities(currentPortfolioId);

  // Mutations
  const upsertMutation = useUpsertHolding(currentPortfolioId);
  const deleteMutation = useDeleteHolding(currentPortfolioId);
  const syncMutation = useSyncHoldingToSnapshot(currentPortfolioId);

  // ===== 加载态 =====
  if (portfoliosLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="持仓" />
        <TableSkeleton rows={5} cols={7} />
      </div>
    );
  }

  // ===== 无组合 =====
  if (portfolios.length === 0) {
    return (
      <EmptyState
        title="暂无投资组合"
        description="创建组合后即可管理持仓"
        action={
          <Button onClick={() => navigate(ROUTE_PATH.SETTINGS)}>
            前往设置管理组合
          </Button>
        }
      />
    );
  }

  // ===== 未选组合 =====
  if (!currentPortfolioId) {
    return (
      <Card className="mx-auto max-w-md">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          请先在顶部选择一个投资组合
        </CardContent>
      </Card>
    );
  }

  const items = holdings.data?.items ?? [];
  const aggregate = holdings.data?.aggregate;
  const securityList = securities.data ?? [];

  function handleSave(data: HoldingFormData): void {
    upsertMutation.mutate(
      {
        securityId: data.securityId,
        date: data.date,
        quantity: data.quantity,
        avgCost: data.avgCost,
        marketPrice: data.marketPrice,
        note: data.note || undefined,
      },
      {
        onSuccess: () => {
          setFormOpen(false);
          setEditHolding(null);
        },
      },
    );
  }

  function handleDelete(): void {
    if (!deleteId) return;
    deleteMutation.mutate(deleteId, {
      onSuccess: () => setDeleteId(null),
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="持仓"
        description={selectedDate ? `日期 ${selectedDate}` : undefined}
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditHolding(null);
                setFormOpen(true);
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              新增持仓
            </Button>
            {aggregate && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => syncMutation.mutate(selectedDate)}
                disabled={syncMutation.isPending}
              >
                <RefreshCw
                  className={cn(
                    'mr-2 h-4 w-4',
                    syncMutation.isPending && 'animate-spin',
                  )}
                />
                同步至快照
              </Button>
            )}
          </div>
        }
      />

      {/* 日期选择 + 类型筛选 */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Label className="text-sm">日期</Label>
          <Select
            value={selectedDate}
            onValueChange={setSelectedDate}
          >
            <SelectTrigger className="w-40">
              <SelectValue placeholder="选择日期" />
            </SelectTrigger>
            <SelectContent>
              {(dates.data ?? []).map((d) => (
                <SelectItem key={d} value={d}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Tabs value={typeFilter} onValueChange={setTypeFilter}>
          <TabsList>
            <TabsTrigger value="ALL">全部</TabsTrigger>
            {Object.entries(SECURITY_TYPE_LABEL).map(([k, v]) => (
              <TabsTrigger key={k} value={k}>
                {v}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {/* ===== 错误态 ===== */}
      {holdings.isError && (
        <Card className="border-destructive/50">
          <CardContent className="flex flex-col items-center gap-4 py-8">
            <AlertTriangle className="h-8 w-8 text-destructive" />
            <p className="text-sm text-destructive">数据加载失败</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => holdings.refetch()}
            >
              重新加载
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ===== 加载态 ===== */}
      {holdings.isLoading && <TableSkeleton rows={5} cols={7} />}

      {/* ===== 空态 ===== */}
      {!holdings.isLoading &&
        !holdings.isError &&
        items.length === 0 && (
          <EmptyState
            icon={<PackageOpen className="h-12 w-12" />}
            title="暂无持仓数据"
            description={
              securityList.length === 0
                ? '请先新增标的，再录入持仓数据'
                : '点击「新增持仓」录入第一笔持仓'
            }
            action={
              <div className="flex gap-2">
                {securityList.length === 0 && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setEditHolding(null);
                      setFormOpen(true);
                    }}
                  >
                    新建标的
                  </Button>
                )}
                <Button
                  onClick={() => {
                    setEditHolding(null);
                    setFormOpen(true);
                  }}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  新增持仓
                </Button>
              </div>
            }
          />
        )}

      {/* ===== 数据态 ===== */}
      {!holdings.isLoading && !holdings.isError && items.length > 0 && (
        <>
          {/* 汇总条 */}
          {aggregate && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <Card>
                <CardContent className="py-3">
                  <p className="text-xs text-muted-foreground">总市值</p>
                  <p className="text-lg font-bold tabular-nums">
                    ¥{formatCurrency(aggregate.totalMarketValue)}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-3">
                  <p className="text-xs text-muted-foreground">总成本</p>
                  <p className="text-lg font-bold tabular-nums">
                    ¥{formatCurrency(aggregate.totalCost)}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-3">
                  <p className="text-xs text-muted-foreground">总浮动盈亏</p>
                  <p
                    className={cn(
                      'text-lg font-bold tabular-nums',
                      parseFloat(aggregate.totalProfit) >= 0
                        ? 'text-red-600'
                        : 'text-emerald-600',
                    )}
                  >
                    {parseFloat(aggregate.totalProfit) >= 0 ? '+' : ''}
                    ¥{formatCurrency(aggregate.totalProfit)}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-3">
                  <p className="text-xs text-muted-foreground">总盈亏率</p>
                  <p
                    className={cn(
                      'text-lg font-bold tabular-nums',
                      parseFloat(aggregate.totalProfitRate) >= 0
                        ? 'text-red-600'
                        : 'text-emerald-600',
                    )}
                  >
                    {formatPercent(aggregate.totalProfitRate)}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-3">
                  <p className="text-xs text-muted-foreground">标的数</p>
                  <p className="text-lg font-bold tabular-nums">
                    {aggregate.securityCount}
                  </p>
                </CardContent>
              </Card>
            </div>
          )}

          {/* 持仓表格 */}
          <Card>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8"></TableHead>
                    <TableHead>标的</TableHead>
                    <TableHead>代码</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead className="text-right">数量</TableHead>
                    <TableHead className="text-right">成本价</TableHead>
                    <TableHead className="text-right">现价</TableHead>
                    <TableHead className="text-right">市值</TableHead>
                    <TableHead className="text-right">盈亏</TableHead>
                    <TableHead className="text-right">盈亏%</TableHead>
                    <TableHead className="text-right">占比</TableHead>
                    <TableHead className="w-20">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((h) => {
                    const profit = parseFloat(h.profit);
                    const profitRate = parseFloat(h.profitRate);
                    const isExpanded = expandedId === h.id;

                    return (
                      <>
                        <TableRow
                          key={h.id}
                          className={cn(
                            'cursor-pointer transition-colors hover:bg-muted/30',
                            isExpanded && 'bg-muted/20',
                          )}
                        >
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() =>
                                setExpandedId(isExpanded ? null : h.id)
                              }
                            >
                              {isExpanded ? (
                                <ChevronUp className="h-4 w-4" />
                              ) : (
                                <ChevronDown className="h-4 w-4" />
                              )}
                            </Button>
                          </TableCell>
                          <TableCell
                            className="font-medium"
                            onClick={() =>
                              setExpandedId(isExpanded ? null : h.id)
                            }
                          >
                            {h.securityName}
                          </TableCell>
                          <TableCell
                            className="text-muted-foreground"
                            onClick={() =>
                              setExpandedId(isExpanded ? null : h.id)
                            }
                          >
                            {h.securityCode}
                          </TableCell>
                          <TableCell onClick={() =>
                            setExpandedId(isExpanded ? null : h.id)
                          }>
                            <Badge variant="secondary" className="text-xs">
                              {SECURITY_TYPE_LABEL[h.securityType] ||
                                h.securityType}
                            </Badge>
                          </TableCell>
                          <TableCell
                            className="text-right tabular-nums"
                            onClick={() =>
                              setExpandedId(isExpanded ? null : h.id)
                            }
                          >
                            {formatCurrency(h.quantity, 2)}
                          </TableCell>
                          <TableCell
                            className="text-right tabular-nums"
                            onClick={() =>
                              setExpandedId(isExpanded ? null : h.id)
                            }
                          >
                            ¥{formatCurrency(h.avgCost)}
                          </TableCell>
                          <TableCell
                            className="text-right tabular-nums"
                            onClick={() =>
                              setExpandedId(isExpanded ? null : h.id)
                            }
                          >
                            ¥{formatCurrency(h.marketPrice)}
                          </TableCell>
                          <TableCell
                            className="text-right tabular-nums"
                            onClick={() =>
                              setExpandedId(isExpanded ? null : h.id)
                            }
                          >
                            ¥{formatCurrency(h.marketValue)}
                          </TableCell>
                          <TableCell
                            className={cn(
                              'text-right tabular-nums',
                              profit >= 0
                                ? 'text-red-600'
                                : 'text-emerald-600',
                            )}
                            onClick={() =>
                              setExpandedId(isExpanded ? null : h.id)
                            }
                          >
                            {profit >= 0 ? '+' : ''}
                            ¥{formatCurrency(Math.abs(profit))}
                          </TableCell>
                          <TableCell
                            className={cn(
                              'text-right tabular-nums',
                              profitRate >= 0
                                ? 'text-red-600'
                                : 'text-emerald-600',
                            )}
                            onClick={() =>
                              setExpandedId(isExpanded ? null : h.id)
                            }
                          >
                            {formatPercent(h.profitRate)}
                          </TableCell>
                          <TableCell
                            className="text-right tabular-nums"
                            onClick={() =>
                              setExpandedId(isExpanded ? null : h.id)
                            }
                          >
                            {formatPercent(h.weight)}
                          </TableCell>
                          <TableCell>
                            <div className="flex gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditHolding(h);
                                  setFormOpen(true);
                                }}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-destructive"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDeleteId(h.id);
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                        {/* 展开详情 */}
                        {isExpanded && (
                          <TableRow>
                            <TableCell colSpan={12} className="bg-muted/10 px-6">
                              <HoldingDetailPanel
                                holding={h}
                                portfolioId={currentPortfolioId}
                              />
                            </TableCell>
                          </TableRow>
                        )}
                      </>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </Card>
        </>
      )}

      {/* ===== 表单弹窗 ===== */}
      <HoldingFormDialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditHolding(null);
        }}
        portfolioId={currentPortfolioId}
        securities={securityList}
        editData={editHolding}
        onSave={handleSave}
        saving={upsertMutation.isPending}
      />

      {/* ===== 删除确认 ===== */}
      <AlertDialog
        open={Boolean(deleteId)}
        onOpenChange={(open) => !open && setDeleteId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              删除后该持仓记录将不可恢复。是否确认？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? '删除中…' : '确认删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
