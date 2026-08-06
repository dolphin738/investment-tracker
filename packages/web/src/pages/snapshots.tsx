/**
 * pages/snapshots.tsx — 资产记录页（PRD §7.3）
 *
 * - 列表：日期/总资产/持仓/现金/来源（🤖自动/✋手工）/系统自动值+差异%/备注/操作
 * - 操作：✎编辑（变手工）、🗑删除（事件日会重新生成自动值）、↺重置（仅手工记录）
 * - 新建/编辑弹窗：日期（不可未来）/总资产（必填）/持仓/现金/备注 + 系统自动值覆盖提示
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
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SnapshotForm } from '@/features/snapshot/snapshot-form';
import { SnapshotList } from '@/features/snapshot/snapshot-list';
import { usePortfolioStore } from '@/stores/portfolio.store';
import type { AssetSnapshot } from '@investment-tracker/shared';

export default function SnapshotsPage(): JSX.Element {
  const currentPortfolioId = usePortfolioStore((s) => s.currentPortfolioId);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<AssetSnapshot | null>(null);

  if (!currentPortfolioId) {
    return (
      <Card className="mx-auto max-w-md">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          请先选择一个投资组合
        </CardContent>
      </Card>
    );
  }

  const handleEdit = (item: AssetSnapshot) => {
    setEditing(item);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">历史总资产记录</h1>
          <p className="text-sm text-muted-foreground">
            🤖 默认由系统每日自动记录；✋ 您也可手工补录或修正某日数值
          </p>
          <p className="text-sm text-muted-foreground">
            ⓘ 每天只保留一条记录：手工记录会取代当天的自动记录
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Gap D（SET-P0-03 同口径）：后端导出接口未实现，视觉占位禁用 */}
          <Button
            variant="outline"
            disabled
            title="v1 暂未开放（SET-P0-03）：导出接口待后端实现"
          >
            导出 CSV
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            + 新建记录
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">历史记录</CardTitle>
          <CardDescription>
            来源 🤖自动 = 系统按交易/余额推导；✋手工 = 用户录入（可重置）
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SnapshotList
            portfolioId={currentPortfolioId}
            query={{ pageSize: 20 }}
            onEdit={handleEdit}
          />
        </CardContent>
      </Card>

      {/* 底部图例（§7.3） */}
      <div className="space-y-1 rounded-md border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
        <p>ⓘ「沿用」= 当日无价格/现金更新，按前值沿用</p>
        <p>ⓘ「按成本」= 存在无价格记录的标的，按成本价估值</p>
        <p>ⓘ 每天唯一一条记录；手工录入会取代该日自动记录</p>
        <p>✎ = 编辑该日记录（保存后该日变为手工记录）</p>
        <p>🗑 = 删除该日记录（事件日会被系统重新生成自动值）</p>
        <p>↺ = 撤销手工修改、恢复系统计算值（仅手工记录可用）</p>
      </div>

      {/* 新建弹窗 */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>录入资产记录</DialogTitle>
            <DialogDescription>
              保存后将成为手工记录并触发净值/XIRR 重算
            </DialogDescription>
          </DialogHeader>
          <SnapshotForm
            portfolioId={currentPortfolioId}
            onSuccess={() => setCreateOpen(false)}
          />
        </DialogContent>
      </Dialog>

      {/* 编辑弹窗（自动行保存后变手工） */}
      <Dialog open={Boolean(editing)} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>编辑资产记录</DialogTitle>
            <DialogDescription>
              保存后将变为手工记录（✎编辑 = 变手工）
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <SnapshotForm
              portfolioId={currentPortfolioId}
              snapshot={editing}
              onSuccess={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
