/**
 * features/admin/interface-category-section.tsx — 接口分类管理板块
 *
 * 分类改版后为固定 2 类（证券列表 / 证券行情，分类即用途），故不提供新增 / 删除入口，
 * 仅允许编辑展示名 / 图标 / 排序；系统内置分类以 badge 标注。
 */

import { useState, type ComponentType } from 'react';
import { Pencil } from 'lucide-react';
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
import type { InterfaceCategory } from '@/api/interface-category.api';
import { useInterfaceCategories } from '@/hooks/use-interface-category';
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

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<InterfaceCategory | null>(null);

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
              系统固定 2 个分类（分类即接口用途）：「证券列表」拉取证券主数据，「证券行情」拉取价格；
              可调整展示名 / 图标 / 排序，不可新增或删除
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <p className="py-8 text-center text-sm text-muted-foreground">加载中…</p>
        )}
          {!isLoading && categories && categories.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            暂无分类
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
                  <TableCell className="font-medium">
                    <span className="inline-flex items-center gap-2">
                      {c.label}
                      {c.system && (
                        <span className="rounded border px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                          系统内置
                        </span>
                      )}
                    </span>
                  </TableCell>
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
    </Card>
  );
}
