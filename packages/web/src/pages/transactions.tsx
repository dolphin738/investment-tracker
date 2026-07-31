/**
 * pages/transactions.tsx — 交易管理页
 *
 * 左侧：交易录入表单（新建模式）
 * 右侧：最近交易记录列表（可编辑/删除）
 */

import { useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { TransactionForm } from '@/features/transaction/transaction-form';
import { TransactionList } from '@/features/transaction/transaction-list';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Plus } from 'lucide-react';

export default function TransactionsPage(): JSX.Element {
  const currentPortfolioId = usePortfolioStore((s) => s.currentPortfolioId);
  const [open, setOpen] = useState(false);

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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* 录入表单 */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-base">录入交易</CardTitle>
            <CardDescription>填写交易日期、方向、金额</CardDescription>
          </CardHeader>
          <CardContent>
            <TransactionForm portfolioId={currentPortfolioId} />
          </CardContent>
        </Card>

        {/* 交易列表 */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">最近交易记录</CardTitle>
            <CardDescription>支持编辑、删除（删除将触发重算）</CardDescription>
          </CardHeader>
          <CardContent>
            <TransactionList portfolioId={currentPortfolioId} query={{ pageSize: 50 }} />
          </CardContent>
        </Card>
      </div>

      {/* 新建交易对话框（移动端友好） */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
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
