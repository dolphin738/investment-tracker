/**
 * features/admin/quote-provider-dialog.tsx — 数据来源（提供方）新增/编辑对话框
 *
 * 字段：name、access_method（Select）、base_url | sdk_name（按接入方式二选一）、
 * description、enabled、is_default、is_active。
 * 「当前」与「默认」均为全局至多一个，由后端写入时保证互斥；禁用的提供方（enabled=false）不可设为当前/默认。
 *
 * 风格对齐同模块其它对话框（QuoteInterfaceDialog / InterfaceCategoryDialog）：
 * - 独立 *-dialog.tsx 组件，props 为 { open, onOpenChange, editing }；
 * - 表单状态由对话框内部持有，以 toForm(editing) + useEffect 在每次打开时重置；
 * - 接入方式使用 shadcn Select（与 QuoteInterfaceDialog 的 HTTP 方法一致）；
 * - 提交后 onOpenChange(false) 关闭并就地刷新列表（由 hooks 失效缓存）。
 */

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import type { QuoteProvider, QuoteProviderAccessMethod } from '@/api/quote-provider.api';
import { useCreateQuoteProvider, useUpdateQuoteProvider } from '@/hooks/use-quote-provider';

interface FormState {
  name: string;
  accessMethod: QuoteProviderAccessMethod;
  baseUrl: string;
  sdkName: string;
  description: string;
  enabled: boolean;
  isDefault: boolean;
  isActive: boolean;
}

function toForm(edit: QuoteProvider | null): FormState {
  if (!edit) {
    return {
      name: '',
      accessMethod: 'https',
      baseUrl: '',
      sdkName: '',
      description: '',
      enabled: true,
      isDefault: false,
      isActive: false,
    };
  }
  return {
    name: edit.name,
    accessMethod: edit.access_method,
    baseUrl: (edit.config?.base_url as string) ?? '',
    sdkName: (edit.config?.sdk_name as string) ?? '',
    description: edit.description ?? '',
    enabled: edit.enabled,
    isDefault: edit.is_default,
    isActive: edit.is_active,
  };
}

export interface QuoteProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: QuoteProvider | null;
}

export function QuoteProviderDialog({
  open,
  onOpenChange,
  editing,
}: QuoteProviderDialogProps): JSX.Element {
  const createMut = useCreateQuoteProvider();
  const updateMut = useUpdateQuoteProvider();
  const [form, setForm] = useState<FormState>(() => toForm(editing));

  useEffect(() => {
    if (open) setForm(toForm(editing));
  }, [open, editing]);

  const pending = createMut.isPending || updateMut.isPending;

  const handleSubmit = (): void => {
    const name = form.name.trim();
    if (!name) {
      toast.error('请填写名称');
      return;
    }
    if (form.accessMethod === 'https' && !form.baseUrl.trim()) {
      toast.error('HTTPS 接入方式必须填写 API 基础地址');
      return;
    }
    if (form.accessMethod === 'sdk' && !form.sdkName.trim()) {
      toast.error('SDK 接入方式必须填写 SDK 名称');
      return;
    }
    const config =
      form.accessMethod === 'https'
        ? { base_url: form.baseUrl.trim() }
        : { sdk_name: form.sdkName.trim() };
    const payload = {
      name,
      access_method: form.accessMethod,
      config,
      enabled: form.enabled,
      description: form.description.trim() || null,
      is_default: form.isDefault,
      is_active: form.isActive,
    };
    if (editing) {
      updateMut.mutate(
        { id: editing.id, body: payload },
        { onSuccess: () => onOpenChange(false) },
      );
    } else {
      createMut.mutate(payload, { onSuccess: () => onOpenChange(false) });
    }
  };

  const close = (): void => onOpenChange(false);

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑数据来源' : '新增数据来源'}</DialogTitle>
          <DialogDescription>
            {editing ? '修改该数据来源的配置' : '新增一个行情数据来源（提供方）'}
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
            <Label htmlFor="qp-access-method">接入方式</Label>
            <Select
              value={form.accessMethod}
              onValueChange={(v) =>
                setForm({ ...form, accessMethod: v as QuoteProviderAccessMethod })
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

          {form.accessMethod === 'https' ? (
            <div className="space-y-2">
              <Label htmlFor="qp-base-url">API 基础地址</Label>
              <Input
                id="qp-base-url"
                placeholder="https://example.com/api"
                value={form.baseUrl}
                onChange={(e) =>
                  setForm({ ...form, baseUrl: e.target.value })
                }
              />
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="qp-sdk-name">SDK 名称</Label>
              <Input
                id="qp-sdk-name"
                placeholder="如 akshare"
                value={form.sdkName}
                onChange={(e) =>
                  setForm({ ...form, sdkName: e.target.value })
                }
              />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="qp-desc">描述</Label>
            <Textarea
              id="qp-desc"
              placeholder="可选，备注该数据来源用途"
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
              onCheckedChange={(v) =>
                setForm({
                  ...form,
                  enabled: v,
                  isActive: v ? form.isActive : false,
                  isDefault: v ? form.isDefault : false,
                })
              }
            />
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <Label htmlFor="qp-default" className="text-sm">
              设为默认
            </Label>
            <Switch
              id="qp-default"
              checked={form.isDefault}
              disabled={!form.enabled}
              onCheckedChange={(v) => setForm({ ...form, isDefault: v })}
            />
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="qp-active" className="text-sm">
                当前
              </Label>
              <p className="text-xs text-muted-foreground">
                设为系统当前使用的行情来源（全局至多一个；启用后方可选）
              </p>
            </div>
            <Switch
              id="qp-active"
              checked={form.isActive}
              disabled={!form.enabled}
              onCheckedChange={(v) => setForm({ ...form, isActive: v })}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={pending}>
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
