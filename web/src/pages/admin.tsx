/**
 * pages/admin.tsx — 系统管理页（仅管理员可见）
 *
 * 证券行情数据提供方「多提供方管理」（取代旧的单 URL 系统配置）：
 * - 以表格列出全部提供方，并标注「默认 / 当前 / 已禁用」状态。
 * - 新增 / 编辑对话框：名称、类型、接入方式（HTTPS / SDK）、连接参数、
 *   是否启用、是否设为默认、描述。
 * - 行内操作：设为默认、切换当前使用方、删除（二次确认）。
 * - 非管理员访问时仅展示「无权限访问」，且不发起任何 /admin 请求
 *   （useQuoteProviders 的 enabled:isAdmin 保证）。
 */

import { useState } from 'react';
import { Loader2, Plus, Pencil, Star, Zap, Trash2 } from 'lucide-react';
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
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { useIsAdmin } from '@/stores/auth.store';
import {
  useQuoteProviders,
  useCreateQuoteProvider,
  useUpdateQuoteProvider,
  useDeleteQuoteProvider,
  useSetDefaultQuoteProvider,
  useSetActiveQuoteProvider,
} from '@/hooks/use-quote-provider';
import type { QuoteProvider, QuoteProviderAccessMethod } from '@/api/quote-provider.api';

/** 表单本地态（config 拆成 base_url / sdk_name，提交时按接入方式组装） */
interface ProviderForm {
  name: string;
  provider_type: string;
  access_method: QuoteProviderAccessMethod;
  base_url: string;
  sdk_name: string;
  enabled: boolean;
  description: string;
  is_default: boolean;
}

function emptyForm(): ProviderForm {
  return {
    name: '',
    provider_type: '',
    access_method: 'https',
    base_url: '',
    sdk_name: '',
    enabled: true,
    description: '',
    is_default: false,
  };
}

/** 由提供方实体回填表单 */
function providerToForm(p: QuoteProvider): ProviderForm {
  return {
    name: p.name,
    provider_type: p.provider_type,
    access_method: p.access_method,
    base_url: (p.config?.base_url as string) ?? '',
    sdk_name: (p.config?.sdk_name as string) ?? '',
    enabled: p.enabled,
    description: p.description ?? '',
    is_default: p.is_default,
  };
}

/** 由表单组装请求体 config（仅取当前接入方式所需的字段） */
function formToConfig(form: ProviderForm): Record<string, unknown> {
  return form.access_method === 'https'
    ? { base_url: form.base_url.trim() }
    : { sdk_name: form.sdk_name.trim() };
}

export default function AdminPage(): JSX.Element {
  const isAdmin = useIsAdmin();
  const { data: providers, isLoading, isError } = useQuoteProviders();

  const createMut = useCreateQuoteProvider();
  const updateMut = useUpdateQuoteProvider('');
  const deleteMut = useDeleteQuoteProvider();
  const setDefaultMut = useSetDefaultQuoteProvider();
  const setActiveMut = useSetActiveQuoteProvider();

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderForm>(emptyForm());
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const closeDialog = (): void => {
    setOpen(false);
    setEditingId(null);
    setForm(emptyForm());
  };

  const openCreate = (): void => {
    setEditingId(null);
    setForm(emptyForm());
    setOpen(true);
  };

  const openEdit = (p: QuoteProvider): void => {
    setEditingId(p.id);
    setForm(providerToForm(p));
    setOpen(true);
  };

  const handleSubmit = (): void => {
    if (!form.name.trim() || !form.provider_type.trim()) {
      toast.error('请填写名称与类型');
      return;
    }
    if (form.access_method === 'https' && !form.base_url.trim()) {
      toast.error('HTTPS 接入方式必须填写 API 基础地址');
      return;
    }
    if (form.access_method === 'sdk' && !form.sdk_name.trim()) {
      toast.error('SDK 接入方式必须填写 SDK 名称');
      return;
    }
    const config = formToConfig(form);
    const payload = {
      name: form.name.trim(),
      provider_type: form.provider_type.trim(),
      access_method: form.access_method,
      config,
      enabled: form.enabled,
      description: form.description.trim() || null,
      is_default: form.is_default,
    };
    if (editingId) {
      updateMut.mutate(payload, { onSuccess: closeDialog });
    } else {
      createMut.mutate(payload, { onSuccess: closeDialog });
    }
  };

  const pending = createMut.isPending || updateMut.isPending;

  if (!isAdmin) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">系统管理</h1>
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            无权限访问该页面
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">系统管理</h1>
          <p className="text-sm text-muted-foreground">
            证券行情数据提供方（多提供方）配置，仅管理员可见
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" />
          新增提供方
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">证券行情数据提供方</CardTitle>
          <CardDescription>
            配置多个行情数据来源；系统默认使用「当前」方，未指定时回退到「默认」方
          </CardDescription>
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>接入方式</TableHead>
                  <TableHead>连接信息</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {providers.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {p.provider_type}
                    </TableCell>
                    <TableCell>
                      {p.access_method === 'https' ? 'HTTPS' : 'SDK'}
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate text-muted-foreground">
                      {p.access_method === 'https'
                        ? ((p.config?.base_url as string) ?? '-')
                        : ((p.config?.sdk_name as string) ?? '-')}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {p.is_default && (
                          <Badge variant="success">默认</Badge>
                        )}
                        {p.is_active && <Badge>当前</Badge>}
                        {!p.enabled && (
                          <Badge variant="secondary">已禁用</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEdit(p)}
                        >
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
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 新增 / 编辑对话框 */}
      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : closeDialog())}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{editingId ? '编辑提供方' : '新增提供方'}</DialogTitle>
            <DialogDescription>
              {editingId
                ? '修改该行情数据提供方的配置'
                : '新增一个证券行情数据提供方'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="qp-name">名称</Label>
              <Input
                id="qp-name"
                placeholder="如 新浪财经"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="qp-type">类型</Label>
              <Input
                id="qp-type"
                placeholder="如 stock / fund / crypto"
                value={form.provider_type}
                onChange={(e) =>
                  setForm({ ...form, provider_type: e.target.value })
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="qp-access-method">接入方式</Label>
              <Select
                value={form.access_method}
                onValueChange={(v) =>
                  setForm({
                    ...form,
                    access_method: v as QuoteProviderAccessMethod,
                  })
                }
              >
                <SelectTrigger id="qp-access-method">
                  <SelectValue placeholder="选择接入方式" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="https">HTTPS（API 地址）</SelectItem>
                  <SelectItem value="sdk">SDK（如 akshare）</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {form.access_method === 'https' ? (
              <div className="space-y-2">
                <Label htmlFor="qp-base-url">API 基础地址</Label>
                <Input
                  id="qp-base-url"
                  placeholder="https://example.com/api"
                  value={form.base_url}
                  onChange={(e) =>
                    setForm({ ...form, base_url: e.target.value })
                  }
                />
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="qp-sdk-name">SDK 名称</Label>
                <Input
                  id="qp-sdk-name"
                  placeholder="如 akshare"
                  value={form.sdk_name}
                  onChange={(e) =>
                    setForm({ ...form, sdk_name: e.target.value })
                  }
                />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="qp-desc">描述</Label>
              <Textarea
                id="qp-desc"
                placeholder="可选，备注该提供方用途"
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
              />
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="qp-enabled" className="text-sm">
                  启用
                </Label>
                <p className="text-xs text-muted-foreground">
                  禁用的提供方不能作为当前使用方
                </p>
              </div>
              <Switch
                id="qp-enabled"
                checked={form.enabled}
                onCheckedChange={(v) => setForm({ ...form, enabled: v })}
              />
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <Label htmlFor="qp-default" className="text-sm">
                设为默认
              </Label>
              <Switch
                id="qp-default"
                checked={form.is_default}
                onCheckedChange={(v) => setForm({ ...form, is_default: v })}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>
              取消
            </Button>
            <Button onClick={handleSubmit} disabled={pending}>
              {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除二次确认 */}
      <AlertDialog
        open={deleteId !== null}
        onOpenChange={(v) => !v && setDeleteId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除该提供方？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后不可恢复；若该提供方为「当前 / 默认」方，系统将回退到其它可用方。
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
