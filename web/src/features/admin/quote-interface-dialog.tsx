/**
 * features/admin/quote-interface-dialog.tsx — 提供方接口新增/编辑对话框
 *
 * 字段：interface_type（Select 读分类 + 自定义）、name、endpoint、http_method、
 * params（JSON textarea）、enabled、description、timeout、retry_count、rate_limit。
 * 不含 direction（后端落库，UI 暂不暴露）。
 */

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import type { HttpMethod, QuoteInterface } from '@/api/quote-interface.api';
import {
  useCreateInterface,
  useUpdateInterface,
} from '@/hooks/use-quote-interface';
import { useInterfaceCategories } from '@/hooks/use-interface-category';

const CUSTOM_VALUE = '__custom__';
const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

interface FormState {
  interfaceType: string;
  customType: string;
  name: string;
  endpoint: string;
  httpMethod: string;
  params: string;
  enabled: boolean;
  description: string;
  timeout: string;
  retryCount: string;
  rateLimit: string;
}

function toForm(edit: QuoteInterface | null): FormState {
  if (!edit) {
    return {
      interfaceType: '',
      customType: '',
      name: '',
      endpoint: '',
      httpMethod: '',
      params: '',
      enabled: true,
      description: '',
      timeout: '',
      retryCount: '',
      rateLimit: '',
    };
  }
  return {
    interfaceType: edit.interface_type,
    customType: '',
    name: edit.name,
    endpoint: edit.endpoint ?? '',
    httpMethod: edit.http_method ?? '',
    params: edit.params ? JSON.stringify(edit.params, null, 2) : '',
    enabled: edit.enabled,
    description: edit.description ?? '',
    timeout: edit.timeout != null ? String(edit.timeout) : '',
    retryCount: edit.retry_count != null ? String(edit.retry_count) : '',
    rateLimit: edit.rate_limit ?? '',
  };
}

export interface QuoteInterfaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerId: string;
  editing: QuoteInterface | null;
}

export function QuoteInterfaceDialog({
  open,
  onOpenChange,
  providerId,
  editing,
}: QuoteInterfaceDialogProps): JSX.Element {
  const { data: categories } = useInterfaceCategories();
  const createMut = useCreateInterface(providerId);
  const updateMut = useUpdateInterface();

  const [form, setForm] = useState<FormState>(() => toForm(editing));

  useEffect(() => {
    if (open) setForm(toForm(editing));
  }, [open, editing]);

  const pending = createMut.isPending || updateMut.isPending;

  const resolveInterfaceType = (): string | null => {
    if (form.interfaceType === CUSTOM_VALUE) {
      const v = form.customType.trim();
      return v || null;
    }
    return form.interfaceType.trim() || null;
  };

  const handleSubmit = (): void => {
    const interfaceType = resolveInterfaceType();
    if (!interfaceType) {
      toast.error('请选择或填写接口分类');
      return;
    }
    if (!form.name.trim()) {
      toast.error('请填写接口名称');
      return;
    }

    let parsedParams: Record<string, unknown> | null = null;
    const rawParams = form.params.trim();
    if (rawParams) {
      try {
        const parsed = JSON.parse(rawParams);
        if (parsed !== null && typeof parsed !== 'object') {
          throw new Error('params 必须是 JSON 对象');
        }
        parsedParams = parsed as Record<string, unknown>;
      } catch {
        toast.error('参数模板不是合法 JSON');
        return;
      }
    }

    const payload = {
      interface_type: interfaceType,
      name: form.name.trim(),
      endpoint: form.endpoint.trim() || null,
      http_method:
        form.httpMethod && form.httpMethod !== '__none__'
          ? (form.httpMethod as HttpMethod)
          : null,
      params: parsedParams,
      enabled: form.enabled,
      description: form.description.trim() || null,
      timeout: form.timeout.trim() ? Number(form.timeout) : null,
      retry_count: form.retryCount.trim() ? Number(form.retryCount) : null,
      rate_limit: form.rateLimit.trim() || null,
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
          <DialogTitle>{editing ? '编辑接口' : '新增接口'}</DialogTitle>
          <DialogDescription>
            {editing ? '修改该提供方下的行情接口' : '为提供方新增一个行情接口'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="qi-type">接口分类</Label>
            <Select
              value={form.interfaceType}
              onValueChange={(v) =>
                setForm({ ...form, interfaceType: v })
              }
            >
              <SelectTrigger id="qi-type">
                <SelectValue placeholder="选择分类（或自定义）" />
              </SelectTrigger>
              <SelectContent>
                {(categories ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.key}>
                    {c.label}（{c.key}）
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_VALUE}>自定义…</SelectItem>
              </SelectContent>
            </Select>
            {form.interfaceType === CUSTOM_VALUE && (
              <Input
                id="qi-custom-type"
                placeholder="自定义分类 key，如 ashare_list"
                value={form.customType}
                onChange={(e) =>
                  setForm({ ...form, customType: e.target.value })
                }
              />
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="qi-name">名称</Label>
            <Input
              id="qi-name"
              placeholder="如 沪深股票列表"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="qi-endpoint">调用路径</Label>
              <Input
                id="qi-endpoint"
                placeholder="/api/ashare/list（SDK 时为函数名）"
                value={form.endpoint}
                onChange={(e) =>
                  setForm({ ...form, endpoint: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="qi-method">HTTP 方法</Label>
              <Select
                value={form.httpMethod}
                onValueChange={(v) => setForm({ ...form, httpMethod: v })}
              >
                <SelectTrigger id="qi-method">
                  <SelectValue placeholder="不设置" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">不设置</SelectItem>
                  {HTTP_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="qi-params">参数模板（JSON）</Label>
            <Textarea
              id="qi-params"
              placeholder='{"code": "string"}'
              rows={3}
              value={form.params}
              onChange={(e) => setForm({ ...form, params: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="qi-desc">描述</Label>
            <Textarea
              id="qi-desc"
              placeholder="可选，备注该接口用途"
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="qi-timeout">超时(秒)</Label>
              <Input
                id="qi-timeout"
                type="number"
                placeholder="可选"
                value={form.timeout}
                onChange={(e) =>
                  setForm({ ...form, timeout: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="qi-retry">重试次数</Label>
              <Input
                id="qi-retry"
                type="number"
                placeholder="可选"
                value={form.retryCount}
                onChange={(e) =>
                  setForm({ ...form, retryCount: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="qi-rate">频率限制</Label>
              <Input
                id="qi-rate"
                placeholder="如 100/min"
                value={form.rateLimit}
                onChange={(e) =>
                  setForm({ ...form, rateLimit: e.target.value })
                }
              />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <Label htmlFor="qi-enabled" className="text-sm">
              启用
            </Label>
            <Switch
              id="qi-enabled"
              checked={form.enabled}
              onCheckedChange={(v) => setForm({ ...form, enabled: v })}
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
