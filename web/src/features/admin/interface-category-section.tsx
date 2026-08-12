/**
 * features/admin/interface-category-section.tsx — 接口分类管理板块
 *
 * 列表（label / icon / sort_order）+ 新增 / 编辑 / 删除（删除不影响接口）。
 */

import { useState, type ComponentType } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import * as LucideIcons from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
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
import type { InterfaceCategory } from '@/api/interface-category.api';
import { useDeleteInterfaceCategory, useInterfaceCategories } from '@/hooks/use-interface-category';
import { InterfaceCategoryDialog } from './interface-category-dialog';

/** 动态渲染分类图标：按 c.icon 字符串名从 lucide-react 取组件；缺失或库中不存在回退到 Tag。 */
function CategoryIcon({ name }: { name: string | null }): JSX.Element {
  const Icons = LucideIcons as unknown as Record<
    string,
    ComponentType<{ className?: string }>
  >;
  const Comp = name ? Icons[name] : undefined;
  if (Comp) {
    return <Comp className="h-4 w-4" />;
  }
  return <LucideIcons.Tag className="h-4 w-4 text-muted-foreground" />;
}

export function InterfaceCategorySection(): JSX.Element {
  const { data: categories, isLoading } = useInterfaceCategories();
  const deleteMut = useDeleteInterfaceCategory();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<InterfaceCategory | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const openCreate = (): void => {
    setEditing(null);
    setOpen(true);
  };
  const openEdit = (cat: InterfaceCategory): void => {
    setEditing(cat);
    setOpen(true);
  };
  const close = (): void => {
    setOpen(false);
    setEditing(null);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">接口分类管理</CardTitle>
            <CardDescription>
              配置行情接口的分类（用于接口下拉与「按分类汇总」总览）；删除分类不影响已有接口
            </CardDescription>
          </div>
          <Button onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />
            新增分类
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <p className="py-8 text-center text-sm text-muted-foreground">加载中…</p>
        )}
        {!isLoading && categories && categories.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            暂无分类，点击右上角「新增分类」开始配置
          </p>
        )}
        {!isLoading && categories && categories.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>展示名</TableHead>
                <TableHead>图标</TableHead>
                <TableHead>排序</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {categories.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.label}</TableCell>
                  <TableCell>
                    <CategoryIcon name={c.icon} />
                  </TableCell>
                  <TableCell>{c.sort_order}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(c)}
                      >
                        <Pencil className="mr-1 h-3.5 w-3.5" />
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-500 hover:text-red-600"
                        onClick={() => setDeleteId(c.id)}
                      >
                        <Trash2 className="mr-1 h-3.5 w-3.5" />
                        删除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <InterfaceCategoryDialog
        open={open}
        onOpenChange={(v) => (v ? setOpen(true) : close())}
        editing={editing}
      />

      <AlertDialog
        open={deleteId !== null}
        onOpenChange={(v) => !v && setDeleteId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除该分类？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后不影响已有的接口（接口变为「未分类」）。此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-500 hover:bg-red-600"
              onClick={() => {
                if (deleteId) {
                  deleteMut.mutate(deleteId, {
                    onSuccess: () => setDeleteId(null),
                  });
                }
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
