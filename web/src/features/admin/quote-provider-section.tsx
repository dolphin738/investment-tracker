/**
 * features/admin/quote-provider-section.tsx — 数据来源（提供方）管理板块
 *
 * - 提供方按接入方式分组（HTTPS 提供方 / SDK 提供方）。
 * - 每个提供方行：编辑 / 设为默认 / 切换当前 / 删除（沿用现有 hooks）。
 * - 每个提供方展开区：接口子表（按 interface_type 分组，复用 useQuoteInterfaces）+ 新增/编辑/删除接口。
 * - 顶层「按分类汇总所有提供方接口」总览（ InterfacesByCategoryOverview，扁平接口按 interface_type 聚合）。
 * - 新增 / 编辑提供方走独立对话框组件 QuoteProviderDialog（与同模块其它对话框风格一致）。
 */

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Pencil, Plus, Star, Trash2, Zap } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import {
  useDeleteQuoteProvider,
  useQuoteProviders,
  useSetActiveQuoteProvider,
  useSetDefaultQuoteProvider,
} from '@/hooks/use-quote-provider';
import type { QuoteProvider } from '@/api/quote-provider.api';
import {
  useCreateInterface,
  useDeleteInterface,
  useQuoteInterfaces,
  useQuoteInterfacesAll,
} from '@/hooks/use-quote-interface';
import { useInterfaceCategories } from '@/hooks/use-interface-category';
import type { QuoteInterface } from '@/api/quote-interface.api';
import { QuoteInterfaceDialog } from './quote-interface-dialog';
import { QuoteProviderDialog } from './quote-provider-dialog';

/** 分类 key → 展示名（无匹配显示 raw key） */
function useCategoryLabelMap(): Map<string, string> {
  const { data: categories } = useInterfaceCategories();
  return useMemo(() => {
    const m = new Map<string, string>();
    (categories ?? []).forEach((c) => m.set(c.key, c.label));
    return m;
  }, [categories]);
}

export function QuoteProviderSection(): JSX.Element {
  const { data: providers, isLoading, isError } = useQuoteProviders();
  const deleteMut = useDeleteQuoteProvider();
  const setDefaultMut = useSetDefaultQuoteProvider();
  const setActiveMut = useSetActiveQuoteProvider();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<QuoteProvider | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const openCreate = (): void => {
    setEditing(null);
    setOpen(true);
  };
  const openEdit = (p: QuoteProvider): void => {
    setEditing(p);
    setOpen(true);
  };
  const handleDialogOpenChange = (v: boolean): void => {
    if (v) setOpen(true);
    else {
      setOpen(false);
      setEditing(null);
    }
  };

  const toggleExpand = (id: string): void =>
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  const httpsProviders = (providers ?? []).filter((p) => p.access_method === 'https');
  const sdkProviders = (providers ?? []).filter((p) => p.access_method === 'sdk');

  const renderProviderRow = (p: QuoteProvider): JSX.Element => (
    <TableRow key={p.id}>
      <TableCell>
        <Button
          variant="ghost"
          size="sm"
          className="p-1"
          onClick={() => toggleExpand(p.id)}
          aria-label={expanded[p.id] ? '收起接口' : '展开接口'}
        >
          {expanded[p.id] ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </Button>
      </TableCell>
      <TableCell className="font-medium">{p.name}</TableCell>
      <TableCell className="text-muted-foreground">{p.provider_type}</TableCell>
      <TableCell>{p.access_method === 'https' ? 'HTTPS' : 'SDK'}</TableCell>
      <TableCell className="max-w-[220px] truncate text-muted-foreground">
        {p.access_method === 'https'
          ? ((p.config?.base_url as string) ?? '-')
          : ((p.config?.sdk_name as string) ?? '-')}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {p.is_default && <Badge variant="success">默认</Badge>}
          {p.is_active && <Badge>当前</Badge>}
          {!p.enabled && <Badge variant="secondary">已禁用</Badge>}
        </div>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={() => openEdit(p)}>
            <Pencil className="mr-1 h-3.5 w-3.5" />
            编辑
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={p.is_default}
            onClick={() => setDefaultMut.mutate(p.id)}
            title={p.is_default ? '已是默认' : '设为默认方'}
          >
            <Star className="mr-1 h-3.5 w-3.5" />
            默认
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!p.enabled || p.is_active}
            onClick={() => setActiveMut.mutate(p.id)}
            title={
              !p.enabled
                ? '禁用的提供方不能设为当前使用'
                : p.is_active
                  ? '已是当前使用方'
                  : '切换为当前使用方'
            }
          >
            <Zap className="mr-1 h-3.5 w-3.5" />
            当前
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-red-500 hover:text-red-600"
            onClick={() => setDeleteId(p.id)}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            删除
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="text-base">数据来源</CardTitle>
              <CardDescription>
                配置多个行情数据来源；系统默认使用「当前」方，未指定时回退到「默认」方
              </CardDescription>
            </div>
            <Button onClick={openCreate}>
              <Plus className="mr-2 h-4 w-4" />
              新增提供方
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              加载中…
            </div>
          )}
          {isError && (
            <p className="py-8 text-center text-sm text-red-500">
              加载失败，请刷新重试
            </p>
          )}
          {!isLoading && !isError && providers && providers.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              暂无提供方，点击右上角「新增提供方」开始配置
            </p>
          )}
          {!isLoading && !isError && providers && providers.length > 0 && (
            <div className="space-y-6">
              {httpsProviders.length > 0 && (
                <div>
                  <h4 className="mb-2 text-sm font-medium text-muted-foreground">
                    HTTPS 提供方
                  </h4>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10" />
                        <TableHead>名称</TableHead>
                        <TableHead>类型</TableHead>
                        <TableHead>接入方式</TableHead>
                        <TableHead>连接信息</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead className="text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>{httpsProviders.map(renderProviderRow)}</TableBody>
                  </Table>
                </div>
              )}
              {sdkProviders.length > 0 && (
                <div>
                  <h4 className="mb-2 text-sm font-medium text-muted-foreground">
                    SDK 提供方
                  </h4>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10" />
                        <TableHead>名称</TableHead>
                        <TableHead>类型</TableHead>
                        <TableHead>接入方式</TableHead>
                        <TableHead>连接信息</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead className="text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>{sdkProviders.map(renderProviderRow)}</TableBody>
                  </Table>
                </div>
              )}
              {(providers ?? []).map((p) =>
                expanded[p.id] ? (
                  <ProviderInterfaces key={`exp-${p.id}`} providerId={p.id} />
                ) : null,
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <InterfacesByCategoryOverview />

      {/* 提供方新增 / 编辑对话框（独立组件，风格与同模块其它对话框一致） */}
      <QuoteProviderDialog
        open={open}
        onOpenChange={handleDialogOpenChange}
        editing={editing}
      />

      {/* 提供方删除二次确认 */}
      <AlertDialog
        open={deleteId !== null}
        onOpenChange={(v) => !v && setDeleteId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除该数据来源？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后不可恢复；其下接口将一并删除；若该数据来源为「当前 / 默认」方，系统将回退到其它可用方。
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
    </div>
  );
}

/** 单个提供方下的接口子表（按 interface_type 分组） */
function ProviderInterfaces({ providerId }: { providerId: string }): JSX.Element {
  const { data: interfaces, isLoading } = useQuoteInterfaces(providerId);
  const labelMap = useCategoryLabelMap();
  const createMut = useCreateInterface(providerId);
  const deleteMut = useDeleteInterface();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<QuoteInterface | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const groups = useMemo(() => {
    const map = new Map<string, QuoteInterface[]>();
    (interfaces ?? []).forEach((it) => {
      const k = it.interface_type;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(it);
    });
    return Array.from(map.entries());
  }, [interfaces]);

  const openCreate = (): void => {
    setEditing(null);
    setOpen(true);
  };
  const openEdit = (it: QuoteInterface): void => {
    setEditing(it);
    setOpen(true);
  };
  const close = (): void => {
    setOpen(false);
    setEditing(null);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">接口列表</CardTitle>
          <Button size="sm" variant="outline" onClick={openCreate}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            新增接口
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <p className="py-4 text-center text-sm text-muted-foreground">加载中…</p>
        )}
        {!isLoading && groups.length === 0 && (
          <p className="py-4 text-center text-sm text-muted-foreground">
            该提供方暂无接口
          </p>
        )}
        {!isLoading &&
          groups.map(([type, items]) => (
            <div key={type} className="mb-4">
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                {labelMap.get(type) ?? type}
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>调用路径</TableHead>
                    <TableHead>方法</TableHead>
                    <TableHead>启用</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((it) => (
                    <TableRow key={it.id}>
                      <TableCell className="font-medium">{it.name}</TableCell>
                      <TableCell className="max-w-[200px] truncate text-muted-foreground">
                        {it.endpoint ?? '-'}
                      </TableCell>
                      <TableCell>{it.http_method ?? '-'}</TableCell>
                      <TableCell>
                        {it.enabled ? (
                          <Badge variant="success">启用</Badge>
                        ) : (
                          <Badge variant="secondary">停用</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openEdit(it)}
                          >
                            <Pencil className="mr-1 h-3.5 w-3.5" />
                            编辑
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-red-500 hover:text-red-600"
                            onClick={() => setDeleteId(it.id)}
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
            </div>
          ))}
      </CardContent>

      <QuoteInterfaceDialog
        open={open}
        onOpenChange={(v) => (v ? setOpen(true) : close())}
        providerId={providerId}
        editing={editing}
      />

      <AlertDialog
        open={deleteId !== null}
        onOpenChange={(v) => !v && setDeleteId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除该接口？</AlertDialogTitle>
            <AlertDialogDescription>删除后不可恢复。</AlertDialogDescription>
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

/** 顶层「按分类汇总所有提供方接口」总览 */
function InterfacesByCategoryOverview(): JSX.Element {
  const { data: interfaces, isLoading } = useQuoteInterfacesAll();
  const labelMap = useCategoryLabelMap();

  const groups = useMemo(() => {
    const map = new Map<string, QuoteInterface[]>();
    (interfaces ?? []).forEach((it) => {
      const k = it.interface_type;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(it);
    });
    return Array.from(map.entries());
  }, [interfaces]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">按分类汇总所有提供方接口</CardTitle>
        <CardDescription>
          跨提供方按接口分类聚合；无匹配分类时显示原始 key
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <p className="py-8 text-center text-sm text-muted-foreground">加载中…</p>
        )}
        {!isLoading && groups.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            暂无接口
          </p>
        )}
        {!isLoading &&
          groups.map(([type, items]) => (
            <div key={type} className="mb-5">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm font-medium">
                  {labelMap.get(type) ?? type}
                </span>
                <Badge variant="outline">{items.length}</Badge>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>提供方 ID</TableHead>
                    <TableHead>调用路径</TableHead>
                    <TableHead>方法</TableHead>
                    <TableHead>启用</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((it) => (
                    <TableRow key={it.id}>
                      <TableCell className="font-medium">{it.name}</TableCell>
                      <TableCell className="max-w-[160px] truncate font-mono text-xs text-muted-foreground">
                        {it.provider_id}
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate text-muted-foreground">
                        {it.endpoint ?? '-'}
                      </TableCell>
                      <TableCell>{it.http_method ?? '-'}</TableCell>
                      <TableCell>
                        {it.enabled ? (
                          <Badge variant="success">启用</Badge>
                        ) : (
                          <Badge variant="secondary">停用</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}
