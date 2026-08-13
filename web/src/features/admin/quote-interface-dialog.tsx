/**
 * features/admin/quote-interface-dialog.tsx — 提供方接口新增/编辑对话框
 *
 * 字段：categoryId（Select 读分类，纯外键，不允许自定义）、name、endpoint、http_method、
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

/**
 * 归一化用户可能误输入的全角/不可见字符，避免 JSON.parse 误报"不是合法 JSON"。
 * 常见场景：中文输入法下敲出的全角花括号 ｛｝ / 全角引号 ＂" "，以及复制带入的 BOM、零宽空格。
 */
function normalizeJsonInput(raw: string): string {
  return raw
    .replace(/[﻿\u200B\u200C\u200D\uFEFF\u00AD\u2060]/g, '') // 去除 BOM 与零宽字符
    .replace(/\uFF5B/g, '{') // ｛ → {
    .replace(/\uFF5D/g, '}') // ｝ → }
    .replace(/[\uFF02\u201C\u201D]/g, '"') // 全角/弯双引号 → "
    .replace(/[\uFF07\u2018\u2019]/g, "'"); // 全角/弯单引号 → '
}

const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

/** 接口用途（§11：QUOTE 价格行情 / MASTER_LIST 证券列表） */
const PURPOSE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'QUOTE', label: '价格行情（QUOTE）' },
  { value: 'MASTER_LIST', label: '证券列表（MASTER_LIST）' },
];

/** 资产类别（复用 SecurityType；排除 CASH——现金不作主数据字典） */
const ASSET_CLASS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'STOCK', label: '股票（A股）' },
  { value: 'HK_STOCK', label: '港股' },
  { value: 'CONVERTIBLE_BOND', label: '可转债' },
  { value: 'FUND', label: '基金' },
  { value: 'ETF', label: 'ETF' },
  { value: 'INDEX', label: '指数' },
  { value: 'BOND', label: '债券' },
  { value: 'OTHER', label: '其他' },
];

interface FormState {
  categoryId: string;
  name: string;
  endpoint: string;
  httpMethod: string;
  params: string;
  enabled: boolean;
  description: string;
  timeout: string;
  retryCount: string;
  rateLimit: string;
  purpose: string;
  assetClass: string;
  respCodeField: string;
  respPriceField: string;
  respNameField: string;
  respExchangeField: string;
}

function toForm(edit: QuoteInterface | null): FormState {
  if (!edit) {
    return {
      categoryId: '',
      name: '',
      endpoint: '',
      httpMethod: '',
      params: '',
      enabled: true,
      description: '',
      timeout: '',
      retryCount: '',
      rateLimit: '',
      purpose: 'QUOTE',
      assetClass: '',
      respCodeField: '',
      respPriceField: '',
      respNameField: '',
      respExchangeField: '',
    };
  }
  return {
    categoryId: edit.category_id ?? '',
    name: edit.name,
    endpoint: edit.endpoint ?? '',
    httpMethod: edit.http_method ?? '',
    params: edit.params ? JSON.stringify(edit.params, null, 2) : '',
    enabled: edit.enabled,
    description: edit.description ?? '',
    timeout: edit.timeout != null ? String(edit.timeout) : '',
    retryCount: edit.retry_count != null ? String(edit.retry_count) : '',
    rateLimit: edit.rate_limit ?? '',
    purpose: edit.purpose ?? 'QUOTE',
    assetClass: edit.asset_class ?? '',
    respCodeField: edit.resp_code_field ?? '',
    respPriceField: edit.resp_price_field ?? '',
    respNameField: edit.resp_name_field ?? '',
    respExchangeField: edit.resp_exchange_field ?? '',
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

  const handleSubmit = (): void => {
    if (!form.categoryId.trim()) {
      toast.error('请选择接口分类');
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
        const parsed = JSON.parse(normalizeJsonInput(rawParams));
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
      category_id: form.categoryId.trim(),
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
      purpose: form.purpose as 'QUOTE' | 'MASTER_LIST',
      asset_class:
        !form.assetClass || form.assetClass === '__none__'
          ? null
          : form.assetClass,
      resp_code_field: form.respCodeField.trim() || null,
      resp_price_field: form.respPriceField.trim() || null,
      resp_name_field: form.respNameField.trim() || null,
      resp_exchange_field: form.respExchangeField.trim() || null,
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
              value={form.categoryId}
              onValueChange={(v) => setForm({ ...form, categoryId: v })}
            >
              <SelectTrigger id="qi-type">
                <SelectValue placeholder="选择分类" />
              </SelectTrigger>
              <SelectContent>
                {(categories ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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

          <div className="space-y-3 rounded-md border bg-muted/40 p-3">
            <div className="text-sm font-medium">接口用途与证券列表配置</div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="qi-purpose">用途</Label>
                <Select
                  value={form.purpose}
                  onValueChange={(v) => setForm({ ...form, purpose: v })}
                >
                  <SelectTrigger id="qi-purpose">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PURPOSE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="qi-asset-class">资产类别</Label>
                <Select
                  value={form.assetClass}
                  onValueChange={(v) => setForm({ ...form, assetClass: v })}
                >
                  <SelectTrigger id="qi-asset-class">
                    <SelectValue placeholder="不设置" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">不设置</SelectItem>
                    {ASSET_CLASS_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="qi-resp-code">响应代码字段</Label>
                <Input
                  id="qi-resp-code"
                  placeholder="默认 code；数组行填下标 0"
                  value={form.respCodeField}
                  onChange={(e) =>
                    setForm({ ...form, respCodeField: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="qi-resp-price">响应价格字段</Label>
                <Input
                  id="qi-resp-price"
                  placeholder="默认 price；数组行填下标"
                  value={form.respPriceField}
                  onChange={(e) =>
                    setForm({ ...form, respPriceField: e.target.value })
                  }
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="qi-resp-name">响应名称字段</Label>
                <Input
                  id="qi-resp-name"
                  placeholder="默认 name；数组行填下标 1"
                  value={form.respNameField}
                  onChange={(e) =>
                    setForm({ ...form, respNameField: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="qi-resp-exchange">响应交易所字段</Label>
                <Input
                  id="qi-resp-exchange"
                  placeholder="如 exchange / market，缺省按代码前缀推断"
                  value={form.respExchangeField}
                  onChange={(e) =>
                    setForm({ ...form, respExchangeField: e.target.value })
                  }
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              用途选「证券列表（MASTER_LIST）」时，主数据同步按资产类别拉取全市场代码/名称/交易所（配置驱动，换数据源只改配置）；若响应为数组行（如{' '}
              <code className="font-mono">["code","name"]</code>），代码/名称字段填位置下标（如{' '}
              <code className="font-mono">0</code>/<code className="font-mono">1</code>）。
            </p>
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
