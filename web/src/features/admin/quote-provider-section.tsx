/**
 * features/admin/quote-provider-section.tsx — 数据来源（提供方）管理板块
 *
 * - 提供方按接入方式分组（HTTPS 提供方 / SDK 提供方）。
 * - 每个提供方行：编辑 / 设为默认 / 切换当前 / 删除（沿用现有 hooks）。
 * - 每个提供方展开区：接口子表（按 category_id 分组，复用 useQuoteInterfaces）+ 新增/编辑/删除接口。
 * - 顶层「按分类汇总所有提供方接口」总览（ InterfacesByCategoryOverview，扁平接口按 category_id 聚合）。
 * - 新增 / 编辑提供方走独立对话框组件 QuoteProviderDialog（与同模块其它对话框风格一致）。
 */

import { Fragment, type CSSProperties, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  GripVertical,
  Loader2,
  Pencil,
  Plus,
  Power,
  PowerOff,
  Trash2,
} from 'lucide-react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
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
  useUpdateQuoteProvider,
} from '@/hooks/use-quote-provider';
import type { QuoteProvider } from '@/api/quote-provider.api';
import {
  useCreateInterface,
  useDeleteInterface,
  useQuoteInterfaces,
  useQuoteInterfacesAll,
  useReorderInterfaces,
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
    (categories ?? []).forEach((c) => m.set(c.id, c.label));
    return m;
  }, [categories]);
}

/** 启用状态徽标：启用 → success「启用」；关闭 → secondary「停用」。两处状态显示共用，文案统一。 */
function EnabledBadge({ enabled }: { enabled: boolean }): JSX.Element {
  return enabled ? (
    <Badge variant="success">启用</Badge>
  ) : (
    <Badge variant="secondary">停用</Badge>
  );
}

/**
 * 计算拖拽后的新有序 id 列表（ADR-002 优先级链：priority = index）。
 *
 * 纯函数，便于单测；与 InterfacesByCategoryOverview 的 onDragEnd 共用同一算法。
 * - activeId / overId 任一不在列表中 → 原样返回；
 * - 拖到原位（oldIndex === newIndex）→ 原样返回；
 * - 否则按数组移动语义重排。
 */
export function computeReorderedIds(
  ids: readonly string[],
  activeId: string,
  overId: string,
): string[] {
  const oldIndex = ids.indexOf(activeId);
  const newIndex = ids.indexOf(overId);
  if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) {
    return [...ids];
  }
  const next = [...ids];
  next.splice(newIndex, 0, next.splice(oldIndex, 1)[0]);
  return next;
}

export function QuoteProviderSection(): JSX.Element {
  const { data: providers, isLoading, isError } = useQuoteProviders();
  const deleteMut = useDeleteQuoteProvider();
  const updateMut = useUpdateQuoteProvider();

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
    <Fragment key={p.id}>
      <TableRow
        className="cursor-pointer"
        onClick={() => toggleExpand(p.id)}
      >
        <TableCell>
          <span className="inline-flex h-8 w-8 items-center justify-center text-muted-foreground">
            {expanded[p.id] ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </span>
        </TableCell>
      <TableCell className="truncate font-medium">{p.name}</TableCell>
      <TableCell>{p.access_method === 'https' ? 'HTTPS' : 'SDK'}</TableCell>
      <TableCell className="truncate text-muted-foreground">
        {p.access_method === 'https'
          ? ((p.config?.base_url as string) ?? '-')
          : ((p.config?.sdk_name as string) ?? '-')}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {!p.enabled && <Badge variant="secondary">停用</Badge>}
        </div>
      </TableCell>
      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={updateMut.isPending}
            onClick={(e) => {
              e.stopPropagation();
              updateMut.mutate({ id: p.id, body: { enabled: !p.enabled } });
            }}
            title={p.enabled ? '停用该数据来源' : '启用该数据来源'}
          >
            {p.enabled ? (
              <PowerOff className="mr-1 h-3.5 w-3.5" />
            ) : (
              <Power className="mr-1 h-3.5 w-3.5" />
            )}
            {p.enabled ? '停用' : '启用'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => openEdit(p)}>
            <Pencil className="mr-1 h-3.5 w-3.5" />
            编辑
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
    {expanded[p.id] && (
      <TableRow>
        <TableCell colSpan={6} className="bg-muted/40 p-3">
          <ProviderInterfaces providerId={p.id} />
        </TableCell>
      </TableRow>
    )}
  </Fragment>
);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="text-base">数据来源</CardTitle>
              <CardDescription>
                配置多个行情数据来源；运行时按接口分类级优先级链自动选源（详见 ADR-002）
              </CardDescription>
            </div>
            <Button onClick={openCreate}>
              <Plus className="mr-2 h-4 w-4" />
              新增数据来源
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
              暂无数据来源，点击右上角「新增数据来源」开始配置
            </p>
          )}
          {!isLoading && !isError && providers && providers.length > 0 && (
            <div className="space-y-6">
              {httpsProviders.length > 0 && (
                <div>
                  <h4 className="mb-2 text-sm font-medium text-muted-foreground">
                    HTTPS 提供方
                  </h4>
                  <Table className="table-fixed">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10" />
                        <TableHead className="w-[200px]">名称</TableHead>
                        <TableHead className="w-24">接入方式</TableHead>
                        <TableHead className="w-[240px]">连接信息</TableHead>
                        <TableHead className="w-24">状态</TableHead>
                        <TableHead className="w-[260px] text-right">操作</TableHead>
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
                  <Table className="table-fixed">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10" />
                        <TableHead className="w-[200px]">名称</TableHead>
                        <TableHead className="w-24">接入方式</TableHead>
                        <TableHead className="w-[240px]">连接信息</TableHead>
                        <TableHead className="w-24">状态</TableHead>
                        <TableHead className="w-[260px] text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>{sdkProviders.map(renderProviderRow)}</TableBody>
                  </Table>
                </div>
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
              删除后不可恢复；其下接口将一并删除。
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

/** 单个提供方下的接口子表（按 category_id 分组） */
function ProviderInterfaces({ providerId }: { providerId: string }): JSX.Element {
  const { data: interfaces, isLoading } = useQuoteInterfaces(providerId);
  const labelMap = useCategoryLabelMap();
  const { data: providers } = useQuoteProviders();
  const providerEnabled = useMemo(
    () => providers?.find((p) => p.id === providerId)?.enabled ?? true,
    [providers, providerId],
  );
  const createMut = useCreateInterface(providerId);
  const deleteMut = useDeleteInterface();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<QuoteInterface | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const groups = useMemo(() => {
    const map = new Map<string | null, QuoteInterface[]>();
    (interfaces ?? []).forEach((it) => {
      const k = it.category_id;
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
          <Button size="sm" onClick={openCreate}>
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
                {type ? (labelMap.get(type) ?? type) : '未分类'}
              </div>
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[200px] whitespace-nowrap">名称</TableHead>
                    <TableHead className="w-[280px] whitespace-nowrap">调用路径</TableHead>
                    <TableHead className="w-16 whitespace-nowrap">方法</TableHead>
                    <TableHead className="w-20 whitespace-nowrap">启用</TableHead>
                    <TableHead className="w-[140px] text-right whitespace-nowrap">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((it) => (
                    <TableRow key={it.id}>
                      <TableCell className="truncate font-medium align-middle">{it.name}</TableCell>
                      <TableCell className="truncate align-middle text-muted-foreground">
                        {it.endpoint ?? '-'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap align-middle">{it.http_method ?? '-'}</TableCell>
                      <TableCell className="whitespace-nowrap align-middle">
                        <EnabledBadge enabled={providerEnabled && it.enabled} />
                      </TableCell>
                      <TableCell className="text-right align-middle">
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

/** 顶层「按分类汇总所有提供方接口」总览表头（拖拽手柄列 + 5 列） */
function OverviewTableHeader(): JSX.Element {
  return (
    <TableHeader>
      <TableRow>
        <TableHead className="w-8" />
        <TableHead className="w-[200px] whitespace-nowrap">名称</TableHead>
        <TableHead className="w-[180px] whitespace-nowrap">提供方名称</TableHead>
        <TableHead className="w-[280px] whitespace-nowrap">调用路径</TableHead>
        <TableHead className="w-16 whitespace-nowrap">方法</TableHead>
        <TableHead className="w-20 whitespace-nowrap">启用</TableHead>
      </TableRow>
    </TableHeader>
  );
}

/** 总览行（不可拖拽，用于「未分类」分组） */
function OverviewInterfaceRow({
  item,
  provider,
}: {
  item: QuoteInterface;
  provider?: QuoteProvider;
}): JSX.Element {
  return (
    <TableRow key={item.id}>
      <TableCell className="w-8" />
      <TableCell className="truncate font-medium align-middle">{item.name}</TableCell>
      <TableCell className="truncate align-middle text-muted-foreground">
        {provider?.name ?? item.provider_id}
      </TableCell>
      <TableCell className="truncate align-middle text-muted-foreground">
        {item.endpoint ?? '-'}
      </TableCell>
      <TableCell className="whitespace-nowrap align-middle">{item.http_method ?? '-'}</TableCell>
      <TableCell className="whitespace-nowrap align-middle">
        <EnabledBadge
          enabled={(provider?.enabled ?? false) && item.enabled}
        />
      </TableCell>
    </TableRow>
  );
}

/** 总览行（可拖拽，用于已分类分组；手柄在首列） */
function SortableOverviewRow({
  item,
  provider,
}: {
  item: QuoteInterface;
  provider?: QuoteProvider;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <TableRow ref={setNodeRef} style={style}>
      <TableCell className="w-8 align-middle">
        <button
          type="button"
          className="flex h-7 w-7 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-muted active:cursor-grabbing"
          aria-label={`拖拽排序 ${item.name}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>
      </TableCell>
      <TableCell className="truncate font-medium align-middle">{item.name}</TableCell>
      <TableCell className="truncate align-middle text-muted-foreground">
        {provider?.name ?? item.provider_id}
      </TableCell>
      <TableCell className="truncate align-middle text-muted-foreground">
        {item.endpoint ?? '-'}
      </TableCell>
      <TableCell className="whitespace-nowrap align-middle">{item.http_method ?? '-'}</TableCell>
      <TableCell className="whitespace-nowrap align-middle">
        <EnabledBadge
          enabled={(provider?.enabled ?? false) && item.enabled}
        />
      </TableCell>
    </TableRow>
  );
}

/** 单分类分组：已分类 → DndContext+SortableContext 可拖拽调序；未分类 → 普通表格 */
function OverviewCategoryGroup({
  categoryId,
  label,
  items,
  providerById,
}: {
  categoryId: string | null;
  label: string;
  items: QuoteInterface[];
  providerById: Map<string, QuoteProvider>;
}): JSX.Element {
  const reorderMut = useReorderInterfaces();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = items.map((i) => i.id);
    const next = computeReorderedIds(ids, String(active.id), String(over.id));
    if (next.join() === ids.join()) return;
    if (categoryId) {
      reorderMut.mutate({ category_id: categoryId, ordered_ids: next });
    }
  };

  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm font-medium">{label}</span>
        <Badge variant="outline">{items.length}</Badge>
      </div>
      {categoryId ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={items.map((i) => i.id)}
            strategy={verticalListSortingStrategy}
          >
            <Table className="table-fixed">
              <OverviewTableHeader />
              <TableBody>
                {items.map((it) => (
                  <SortableOverviewRow
                    key={it.id}
                    item={it}
                    provider={providerById.get(it.provider_id)}
                  />
                ))}
              </TableBody>
            </Table>
          </SortableContext>
        </DndContext>
      ) : (
        <Table className="table-fixed">
          <OverviewTableHeader />
          <TableBody>
            {items.map((it) => (
              <OverviewInterfaceRow
                key={it.id}
                item={it}
                provider={providerById.get(it.provider_id)}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/** 顶层「按分类汇总所有提供方接口」总览（每分类可拖拽调序，ADR-002 优先级链） */
function InterfacesByCategoryOverview(): JSX.Element {
  const { data: interfaces, isLoading } = useQuoteInterfacesAll();
  const labelMap = useCategoryLabelMap();
  const { data: providers } = useQuoteProviders();
  const providerById = useMemo(() => {
    const m = new Map<string, QuoteProvider>();
    (providers ?? []).forEach((p) => m.set(p.id, p));
    return m;
  }, [providers]);

  const groups = useMemo(() => {
    const map = new Map<string | null, QuoteInterface[]>();
    (interfaces ?? []).forEach((it) => {
      const k = it.category_id;
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
          跨提供方按接口分类聚合；未分类时显示「未分类」；已分类分组可拖拽手柄调整优先级顺序
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
            <OverviewCategoryGroup
              key={type ?? 'uncategorized'}
              categoryId={type}
              label={type ? (labelMap.get(type) ?? type) : '未分类'}
              items={items}
              providerById={providerById}
            />
          ))}
      </CardContent>
    </Card>
  );
}
