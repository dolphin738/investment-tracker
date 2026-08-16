/**
 * features/admin/quote-interface-dialog.tsx — 提供方接口新增/编辑对话框
 *
 * 字段：categoryId（Select 读分类，纯外键，不允许自定义）、name、endpoint、http_method、
 * params（键值对增删，与接口测试面板一致）、enabled、description、timeout、retry_count、rate_limit。
 * 不含 direction（后端落库，UI 暂不暴露）。
 */

import { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
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
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import type { HttpMethod, QuoteInterface } from '@/api/quote-interface.api';
import {
  useCreateInterface,
  useUpdateInterface,
} from '@/hooks/use-quote-interface';
import { useInterfaceCategories } from '@/hooks/use-interface-category';

/** 由表单的响应解析协议字段拼成 response_parse 对象（全空则返回 null）。 */
function buildResponseParse(form: FormState): Record<string, string> | null {
  const rp: Record<string, string> = {};
  if (form.rpFormat.trim()) rp.format = form.rpFormat.trim();
  // 仅文本分隔格式才需要编码/分隔符/行提取正则；json 不持久化这些字段
  if (form.rpFormat === 'text_split') {
    if (form.rpEncoding.trim()) rp.encoding = form.rpEncoding.trim();
    if (form.rpSep.trim()) rp.sep = form.rpSep.trim();
    if (form.rpLineRegex.trim()) rp.line_regex = form.rpLineRegex.trim();
  }
  if (form.rpCodeParam.trim()) rp.code_param = form.rpCodeParam.trim();
  if (form.rpCodePrefix.trim()) rp.code_prefix = form.rpCodePrefix.trim();
  return Object.keys(rp).length ? rp : null;
}

const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

/** 资产类别（复用 SecurityType；排除 CASH——现金不作主数据字典） */
const ASSET_CLASS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'STOCK', label: '股票（A股）' },
  { value: 'HK_STOCK', label: '港股' },
  { value: 'CONVERTIBLE_BOND', label: '可转债' },
  { value: 'ON_EXCHANGE_FUND', label: '场内基金' },
  { value: 'OFF_EXCHANGE_FUND', label: '场外基金' },
  { value: 'INDEX', label: '指数' },
  { value: 'BOND', label: '债券' },
  { value: 'OTHER', label: '其他' },
];

/** 响应解析协议格式（json 默认 / text_split 非 JSON 文本分隔） */
const RP_FORMAT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'json', label: 'JSON（默认）' },
  { value: 'text_split', label: '文本分隔（如腾讯财经 ~）' },
];

/** 参数模板行（与接口测试面板一致：键值对增删） */
interface ParamRow {
  key: string;
  value: string;
}

interface FormState {
  categoryId: string;
  name: string;
  endpoint: string;
  httpMethod: string;
  params: ParamRow[];
  enabled: boolean;
  description: string;
  timeout: string;
  retryCount: string;
  rateLimit: string;
  assetClass: string[];
  respCodeField: string;
  respPriceField: string;
  respNameField: string;
  respExchangeField: string;
  // —— 响应解析协议（覆盖非 JSON 文本源，如腾讯财经 ~ 分隔）——
  rpFormat: string;
  rpEncoding: string;
  rpSep: string;
  rpLineRegex: string;
  rpCodeParam: string;
  rpCodePrefix: string;
}

function toForm(edit: QuoteInterface | null): FormState {
  if (!edit) {
    return {
      categoryId: '',
      name: '',
      endpoint: '',
      httpMethod: '',
      params: [{ key: '', value: '' }],
      enabled: true,
      description: '',
      timeout: '',
      retryCount: '',
      rateLimit: '',
      assetClass: [],
      respCodeField: '',
      respPriceField: '',
      respNameField: '',
      respExchangeField: '',
      rpFormat: 'json',
      rpEncoding: '',
      rpSep: '~',
      rpLineRegex: '',
      rpCodeParam: '',
      rpCodePrefix: '',
    };
  }
  return {
    categoryId: edit.category_id ?? '',
    name: edit.name,
    endpoint: edit.endpoint ?? '',
    httpMethod: edit.http_method ?? '',
    params:
      edit.params && typeof edit.params === 'object'
        ? Object.entries(edit.params as Record<string, unknown>).map(
            ([k, v]) => ({ key: k, value: v == null ? '' : String(v) }),
          )
        : [{ key: '', value: '' }],
    enabled: edit.enabled,
    description: edit.description ?? '',
    timeout: edit.timeout != null ? String(edit.timeout) : '',
    retryCount: edit.retry_count != null ? String(edit.retry_count) : '',
    rateLimit: edit.rate_limit ?? '',
    assetClass: edit.asset_class ?? [],
    respCodeField: edit.resp_code_field ?? '',
    respPriceField: edit.resp_price_field ?? '',
    respNameField: edit.resp_name_field ?? '',
    respExchangeField: edit.resp_exchange_field ?? '',
    rpFormat: (edit.response_parse?.format as string) ?? 'json',
    rpEncoding: (edit.response_parse?.encoding as string) ?? '',
    rpSep: (edit.response_parse?.sep as string) ?? '~',
    rpLineRegex: (edit.response_parse?.line_regex as string) ?? '',
    rpCodeParam: (edit.response_parse?.code_param as string) ?? '',
    rpCodePrefix: (edit.response_parse?.code_prefix as string) ?? '',
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
  const [activeTab, setActiveTab] = useState('basic');

  useEffect(() => {
    if (open) {
      setForm(toForm(editing));
      setActiveTab('basic');
    }
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

    const parsedParams: Record<string, unknown> = {};
    form.params.forEach((r) => {
      const k = r.key.trim();
      if (k) parsedParams[k] = r.value;
    });

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
      asset_class: form.assetClass.length ? form.assetClass : null,
      resp_code_field: form.respCodeField.trim() || null,
      resp_price_field: form.respPriceField.trim() || null,
      resp_name_field: form.respNameField.trim() || null,
      resp_exchange_field: form.respExchangeField.trim() || null,
      response_parse: buildResponseParse(form),
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

  const addParamRow = (): void =>
    setForm({ ...form, params: [...form.params, { key: '', value: '' }] });
  const updateParamRow = (idx: number, patch: Partial<ParamRow>): void =>
    setForm({
      ...form,
      params: form.params.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    });
  const removeParamRow = (idx: number): void =>
    setForm({ ...form, params: form.params.filter((_, i) => i !== idx) });

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑接口' : '新增接口'}</DialogTitle>
          <DialogDescription>
            {editing ? '修改该提供方下的行情接口' : '为提供方新增一个行情接口'}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="w-full">
            <TabsTrigger value="basic" className="flex-1">
              基本信息
            </TabsTrigger>
            <TabsTrigger value="mapping" className="flex-1">
              字段映射
            </TabsTrigger>
            <TabsTrigger value="parse" className="flex-1">
              响应解析
            </TabsTrigger>
            <TabsTrigger value="advanced" className="flex-1">
              高级设置
            </TabsTrigger>
          </TabsList>

          <TabsContent value="basic" className="space-y-4">
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

          <div className="space-y-2">
            <Label>资产类别（可多选）</Label>
            <div className="flex flex-wrap gap-2">
              {ASSET_CLASS_OPTIONS.map((o) => {
                const selected = form.assetClass.includes(o.value);
                return (
                  <button
                    type="button"
                    key={o.value}
                    aria-pressed={selected}
                    onClick={() =>
                      setForm({
                        ...form,
                        assetClass: selected
                          ? form.assetClass.filter((v) => v !== o.value)
                          : [...form.assetClass, o.value],
                      })
                    }
                    className={
                      'rounded-full border px-3 py-1 text-sm transition-colors ' +
                      (selected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input bg-background hover:bg-accent hover:text-accent-foreground')
                    }
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              可多选：勾选的类别决定该接口参与哪些「同步选源批次」调用；证券主数据的资产类别由代码前缀自动识别，不以本栏为准。
            </p>
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
        </TabsContent>

        <TabsContent value="mapping" className="space-y-3">
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
              用途选「证券列表（MASTER_LIST）」时，主数据同步按此接口拉取全市场代码/名称/
              交易所（配置驱动，换数据源只改配置）；证券的资产类型由代码前缀自动识别，不以本栏为准。
              若响应为数组行（如{' '}
              <code className="font-mono">["code","name"]</code>），代码/名称字段填位置下标（如{' '}
              <code className="font-mono">0</code>/<code className="font-mono">1</code>）。
            </p>
        </TabsContent>

        <TabsContent value="parse" className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="qi-rp-format">响应格式</Label>
              <Select
                value={form.rpFormat}
                onValueChange={(v) => setForm({ ...form, rpFormat: v })}
              >
                <SelectTrigger id="qi-rp-format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RP_FORMAT_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {form.rpFormat === 'text_split' && (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="qi-rp-encoding">编码</Label>
                    <Input
                      id="qi-rp-encoding"
                      placeholder="utf-8（腾讯财经填 gbk）"
                      value={form.rpEncoding}
                      onChange={(e) =>
                        setForm({ ...form, rpEncoding: e.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="qi-rp-sep">分隔符</Label>
                    <Input
                      id="qi-rp-sep"
                      placeholder="~"
                      value={form.rpSep}
                      onChange={(e) => setForm({ ...form, rpSep: e.target.value })}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="qi-rp-line-regex">行提取正则</Label>
                  <Input
                    id="qi-rp-line-regex"
                    placeholder='v_(\w+)="([^"]*)"'
                    value={form.rpLineRegex}
                    onChange={(e) =>
                      setForm({ ...form, rpLineRegex: e.target.value })
                    }
                  />
                </div>
              </>
            )}

            <div className="space-y-2">
              <Label htmlFor="qi-rp-code-param">代码参数名</Label>
              <Input
                id="qi-rp-code-param"
                placeholder="code（腾讯财经填 q）"
                value={form.rpCodeParam}
                onChange={(e) =>
                  setForm({ ...form, rpCodeParam: e.target.value })
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="qi-rp-code-prefix">代码前缀补全</Label>
              <Select
                value={form.rpCodePrefix || 'none'}
                onValueChange={(v) =>
                  setForm({ ...form, rpCodePrefix: v === 'none' ? '' : v })
                }
              >
                <SelectTrigger id="qi-rp-code-prefix">
                  <SelectValue placeholder="原样（不补全）" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">原样（不补全）</SelectItem>
                  <SelectItem value="auto">
                    自动补交易所前缀（覆盖 A股/场内基金/港股）
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                选「自动」后，位数感知补全：5 位纯数字补 hk（港股，00700→hk00700）；
                6 位纯数字按首位推断 sh/sz/bj 裸拼（A股/场内基金，如 600519→sh600519、
                000001→sz000001、510300→sh510300，腾讯/新浪风格）；
                已带前缀（sh600519/hk00700）或非数字（AAPL）原样发送，绝不重复加字母。
                东方财富等直接吃纯数字代码的接口保持「原样」即可。
              </p>
            </div>

            <p className="text-xs text-muted-foreground">
              响应格式选「文本分隔」时，按 sep 拆分每行、按 line_regex 提取带前缀代码（group1）与内容（group2）；
              代码前缀（sh/sz/hk/us）会被保留用于归一化。编码默认 utf-8（腾讯财经需 gbk），
              代码参数名默认 code（腾讯财经为 q，且调用路径请以{' '}
              <code className="font-mono">q=</code> 结尾以走内联形态）。
            </p>
        </TabsContent>

        <TabsContent value="advanced" className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="qi-params">参数模板</Label>
              <Button variant="ghost" size="sm" onClick={addParamRow}>
                <Plus className="mr-1 h-3.5 w-3.5" /> 添加参数
              </Button>
            </div>
            {form.params.length === 0 && (
              <p className="text-xs text-muted-foreground">
                暂无可编辑参数，点击「添加参数」新增键值对（如 type / region）
              </p>
            )}
            <div className="space-y-2">
              {form.params.map((row, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input
                    className="w-2/5"
                    placeholder="参数名"
                    value={row.key}
                    onChange={(e) =>
                      updateParamRow(idx, { key: e.target.value })
                    }
                  />
                  <Input
                    className="flex-1"
                    placeholder="参数值"
                    value={row.value}
                    onChange={(e) =>
                      updateParamRow(idx, { value: e.target.value })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removeParamRow(idx)}
                    aria-label="删除参数"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              这些参数会作为查询条件随每次调用发送（如 iTick 的{' '}
              <code className="font-mono">type</code> /{' '}
              <code className="font-mono">region</code>）；空值参数在请求时自动忽略。
            </p>
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
        </TabsContent>
        </Tabs>

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
