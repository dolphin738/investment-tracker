/**
 * pages/settings.tsx — 设置页
 *
 * 包含：
 * - 账户：用户信息 / 退出登录
 * - 组合管理：列表 + 新建 + 编辑 + 删除
 * - 偏好设置：聚合方式（localStorage 持久化）
 * - 数据管理：清空当前组合数据（危险操作，仅占位）
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, Pencil, Plus, Trash2, Loader2 } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
import { PortfolioDialog } from '@/features/portfolio/portfolio-dialog';
import { useAuthStore } from '@/stores/auth.store';
import {
  useDeletePortfolio,
  usePortfolios,
} from '@/hooks/use-portfolios';
import { usePortfolioStore } from '@/stores/portfolio.store';
import { ROUTE_PATH, AGGREGATION_OPTIONS } from '@/lib/constants';
import type { Portfolio } from '@investment-tracker/shared';
import { AggregationMethod } from '@investment-tracker/shared';
import { formatDate } from '@/lib/utils';

const PREF_AGGREGATION_KEY = 'investment_tracker_pref_aggregation';

export default function SettingsPage(): JSX.Element {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const { data: portfolios = [], isLoading } = usePortfolios();
  const deleteMutation = useDeletePortfolio();
  const currentPortfolioId = usePortfolioStore((s) => s.currentPortfolioId);
  const setCurrentPortfolio = usePortfolioStore((s) => s.setCurrentPortfolio);

  const [editing, setEditing] = useState<Portfolio | null>(null);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // 偏好：聚合方式
  const [aggregation, setAggregation] = useState<AggregationMethod>(
    () =>
      (localStorage.getItem(PREF_AGGREGATION_KEY) as AggregationMethod) ||
      AggregationMethod.LAST,
  );

  const handleLogout = () => {
    logout();
    navigate(ROUTE_PATH.LOGIN);
  };

  const handleConfirmDelete = () => {
    if (deletingId) {
      deleteMutation.mutate(deletingId, {
        onSettled: () => setDeletingId(null),
      });
    }
  };

  const handleAggregationChange = (v: AggregationMethod) => {
    setAggregation(v);
    localStorage.setItem(PREF_AGGREGATION_KEY, v);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">设置</h1>
        <p className="text-sm text-muted-foreground">
          管理账户、组合与偏好设置
        </p>
      </div>

      {/* 账户 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">账户</CardTitle>
          <CardDescription>当前登录用户信息</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <Label className="text-xs text-muted-foreground">邮箱</Label>
              <p className="mt-1">{user?.email ?? '-'}</p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">名称</Label>
              <p className="mt-1">{user?.name ?? '-'}</p>
            </div>
          </div>
          <Button variant="outline" onClick={handleLogout}>
            <LogOut className="mr-2 h-4 w-4" />
            退出登录
          </Button>
        </CardContent>
      </Card>

      {/* 组合管理 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">组合管理</CardTitle>
            <CardDescription>创建、编辑或删除投资组合</CardDescription>
          </div>
          <Button onClick={() => setCreating(true)} size="sm">
            <Plus className="mr-2 h-4 w-4" />
            新建组合
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-sm text-muted-foreground">加载中…</div>
          ) : portfolios.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              暂无组合，请点击右上角新建
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>描述</TableHead>
                  <TableHead>成立日</TableHead>
                  <TableHead>币种</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {portfolios.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">
                      {p.id === currentPortfolioId ? (
                        <span className="font-semibold text-primary">{p.name}</span>
                      ) : (
                        <button
                          className="text-left hover:underline"
                          onClick={() => setCurrentPortfolio(p.id)}
                        >
                          {p.name}
                        </button>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {p.description || '-'}
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {p.baseDate ? formatDate(p.baseDate) : '-'}
                    </TableCell>
                    <TableCell className="text-sm">{p.currency}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setEditing(p)}
                          title="编辑"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setDeletingId(p.id)}
                          title="删除"
                        >
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 偏好设置 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">偏好设置</CardTitle>
          <CardDescription>影响分析页的默认展示</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="pref-aggregation">周期聚合方式</Label>
            <Select
              value={aggregation}
              onValueChange={(v) => handleAggregationChange(v as AggregationMethod)}
            >
              <SelectTrigger id="pref-aggregation" className="w-[200px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AGGREGATION_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              按周/月/年聚合时取每个周期最后一条数据（期末值）或平均值
            </p>
          </div>
        </CardContent>
      </Card>

      {/* 数据管理 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">数据管理</CardTitle>
          <CardDescription>导入导出（v1 暂未开放，列入 P1）</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button variant="outline" disabled>
            导入数据 (CSV/Excel)
          </Button>
          <Button variant="outline" disabled className="ml-2">
            导出数据
          </Button>
          <Button variant="outline" disabled className="ml-2">
            下载导入模板
          </Button>
        </CardContent>
      </Card>

      {/* 关于 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">关于</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <div>版本 v1.0.0</div>
          <div>基于 XIRR 算法的投资收益统计系统</div>
        </CardContent>
      </Card>

      {/* 创建/编辑组合对话框 */}
      <PortfolioDialog
        open={creating || Boolean(editing)}
        onOpenChange={(o) => {
          if (!o) {
            setCreating(false);
            setEditing(null);
          }
        }}
        portfolio={editing}
      />

      {/* 删除组合确认 */}
      <AlertDialog
        open={Boolean(deletingId)}
        onOpenChange={(o) => !o && setDeletingId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除该组合？</AlertDialogTitle>
            <AlertDialogDescription>
              删除组合将级联删除其下所有交易、快照、净值与 XIRR 数据，此操作不可撤销。
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
