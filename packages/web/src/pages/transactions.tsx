/**
 * pages/transactions.tsx — 交易管理页
 *
 * 🆕 T05：新增标的筛选下拉框、交易类型筛选
 */

import { useState, useCallback } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
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
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { TransactionForm } from '@/features/transaction/transaction-form';
import { TransactionList } from '@/features/transaction/transaction-list';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { useSecurities } from '@/hooks/use-securities';
import { Plus, RotateCcw } from 'lucide-react';
import { toIsoDate } from '@/lib/constants';
import type { TransactionQuery } from '@/api/types';

export default function TransactionsPage(): JSX.Element {
  const currentPortfolioId = usePortfolioStore((s) => s.currentPortfolioId);
  const [open, setOpen] = useState(false);

  // 🆕 筛选状态
  const [filterType, setFilterType] = useState<string>('all');
  const [filterSecurityId, setFilterSecurityId] = useState<string>('all');
  const [filterStartDate, setFilterStartDate] = useState<string>('');
  const [filterEndDate, setFilterEndDate] = useState<string>('');

  // 🆕 加载标的列表
  const { data: securities = [] } = useSecurities(currentPortfolioId);

  // 🆕 构建查询参数
  const buildQuery = useCallback((): TransactionQuery => {
    const q: TransactionQuery = { pageSize: 50 };
    if (filterType !== 'all') q.type = filterType as 'BUY' | 'SELL';
    if (filterSecurityId !== 'all') q.securityId = filterSecurityId;
    if (filterStartDate) q.startDate = filterStartDate;
    if (filterEndDate) q.endDate = filterEndDate;
    return q;
  }, [filterType, filterSecurityId, filterStartDate, filterEndDate]);

  const [query, setQuery] = useState<TransactionQuery>(buildQuery());

  const handleFilter = () => {
    setQuery(buildQuery());
  };

  const handleReset = () => {
    setFilterType('all');
    setFilterSecurityId('all');
    setFilterStartDate('');
    setFilterEndDate('');
    setQuery({ pageSize: 50 });
  };

  if (!currentPortfolioId) {
    return (
      <Card className="mx-auto max-w-md">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          请先选择一个投资组合
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* 页头 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">交易管理</h1>
          <p className="text-sm text-muted-foreground">
            录入买入/卖出交易，修改后系统将自动重算受影响日期的净值与 XIRR
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          新建交易
        </Button>
      </div>

      {/* 🆕 筛选栏 */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">类型</Label>
              <Select value={filterType} onValueChange={setFilterType}>
                <SelectTrigger className="w-[110px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="BUY">买入</SelectItem>
                  <SelectItem value="SELL">卖出</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">标的</Label>
              <Select value={filterSecurityId} onValueChange={setFilterSecurityId}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="全部标的" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部标的</SelectItem>
                  {securities.map((sec) => (
                    <SelectItem key={sec.id} value={sec.id}>
                      {sec.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">起始日期</Label>
              <Input
                type="date"
                className="w-[150px]"
                value={filterStartDate}
                onChange={(e) => setFilterStartDate(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">截止日期</Label>
              <Input
                type="date"
                className="w-[150px]"
                value={filterEndDate}
                onChange={(e) => setFilterEndDate(e.target.value)}
              />
            </div>

            <div className="flex gap-2">
              <Button size="sm" onClick={handleFilter}>
                筛选
              </Button>
              <Button size="sm" variant="outline" onClick={handleReset}>
                <RotateCcw className="mr-1 h-3.5 w-3.5" />
                重置
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 交易列表 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">交易记录</CardTitle>
          <CardDescription>支持编辑、删除（删除将触发重算）</CardDescription>
        </CardHeader>
        <CardContent>
          <TransactionList
            portfolioId={currentPortfolioId}
            query={query}
          />
        </CardContent>
      </Card>

      {/* 新建交易对话框 */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>录入交易</DialogTitle>
          </DialogHeader>
          <TransactionForm
            portfolioId={currentPortfolioId}
            onSuccess={() => setOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
