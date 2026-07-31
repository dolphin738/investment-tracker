/**
 * pages/snapshots.tsx — 资产快照页
 *
 * 左侧：快照录入表单（含覆盖确认）
 * 右侧：快照记录列表
 */

import { useState } from 'react';
import { Plus } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SnapshotForm } from '@/features/snapshot/snapshot-form';
import { SnapshotList } from '@/features/snapshot/snapshot-list';
import { usePortfolioStore } from '@/stores/portfolio.store';

export default function SnapshotsPage(): JSX.Element {
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
          <h1 className="text-2xl font-bold tracking-tight">资产快照</h1>
          <p className="text-sm text-muted-foreground">
            录入当日资产总额，系统将自动计算当日净值与 XIRR
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          录入快照
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-base">录入快照</CardTitle>
            <CardDescription>每日唯一，重复录入将提示覆盖</CardDescription>
          </CardHeader>
          <CardContent>
            <SnapshotForm portfolioId={currentPortfolioId} />
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">快照记录</CardTitle>
            <CardDescription>支持删除（删除将触发重算）</CardDescription>
          </CardHeader>
          <CardContent>
            <SnapshotList portfolioId={currentPortfolioId} query={{ pageSize: 50 }} />
          </CardContent>
        </Card>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>录入资产快照</DialogTitle>
          </DialogHeader>
          <SnapshotForm
            portfolioId={currentPortfolioId}
            onSuccess={() => setOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
