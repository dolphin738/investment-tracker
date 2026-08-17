<script setup lang="ts">
/**
 * modules/admin/components/QuoteInterfaceDialog.vue — 提供方接口新增/编辑对话框
 *
 * 平移自 React 版 features/admin/quote-interface-dialog.tsx，行为契约一致。
 * 字段：categoryId（Select 读分类，纯外键，不允许自定义）、name、endpoint、http_method、
 * params（键值对增删，与接口测试面板一致）、enabled、description、timeout、retry_count、rate_limit。
 * 内含 4 个 Tabs 页签：基本信息 / 字段映射 / 响应解析 / 高级设置。
 * 不含 direction（后端落库，UI 暂不暴露）。
 */

import { reactive, ref, watch } from 'vue';
import { Loader2, Plus, Trash2 } from 'lucide-vue-next';
import { toast } from '@/composables/use-toast';
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
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import type { HttpMethod } from '@/api/quote-interface.api';
import { useInterfaceCategories } from '../composables/use-interface-category';
import {
  useCreateInterface,
  useUpdateInterface,
} from '../composables/use-quote-interface';
import type { QuoteInterface } from '@/api/quote-interface.api';

/** 由表单的响应解析协议字段拼成 response_parse 对象（全空则返回 null） */
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

const props = defineProps<{
  open: boolean;
  providerId: string;
  /** 传入则编辑模式，否则新增 */
  editing: QuoteInterface | null;
}>();

const emit = defineEmits<{ openChange: [open: boolean] }>();

const { data: categories } = useInterfaceCategories();
const createMut = useCreateInterface(props.providerId);
const updateMut = useUpdateInterface();

const form = reactive<FormState>(toForm(props.editing));
const activeTab = ref('basic');

// 每次打开时按传入接口重置表单并回到基本信息页签
watch(
  () => [props.open, props.editing] as const,
  ([open]) => {
    if (open) {
      Object.assign(form, toForm(props.editing));
      activeTab.value = 'basic';
    }
  },
  { immediate: true },
);

const pending = () => createMut.isPending.value || updateMut.isPending.value;

const addParamRow = (): void => {
  form.params.push({ key: '', value: '' });
};
const removeParamRow = (idx: number): void => {
  form.params.splice(idx, 1);
};

/** 切换资产类别多选（勾选/取消单个） */
function toggleAssetClass(value: string): void {
  const i = form.assetClass.indexOf(value);
  if (i >= 0) form.assetClass.splice(i, 1);
  else form.assetClass.push(value);
}

function handleSubmit(): void {
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

  const payload: Record<string, unknown> = {
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
    asset_class: form.assetClass.length ? [...form.assetClass] : null,
    resp_code_field: form.respCodeField.trim() || null,
    resp_price_field: form.respPriceField.trim() || null,
    resp_name_field: form.respNameField.trim() || null,
    resp_exchange_field: form.respExchangeField.trim() || null,
    response_parse: buildResponseParse(form),
  };

  if (props.editing) {
    updateMut.mutate(
      { id: props.editing.id, body: payload as never },
      { onSuccess: () => emit('openChange', false) },
    );
  } else {
    createMut.mutate(payload as never, {
      onSuccess: () => emit('openChange', false),
    });
  }
}
</script>

<template>
  <Dialog :open="props.open" @update:open="(v: boolean) => emit('openChange', v)">
    <DialogContent class="max-w-xl max-h-[85vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{{ props.editing ? '编辑接口' : '新增接口' }}</DialogTitle>
        <DialogDescription>
          {{ props.editing ? '修改该提供方下的行情接口' : '为提供方新增一个行情接口' }}
        </DialogDescription>
      </DialogHeader>

      <Tabs v-model="activeTab">
        <TabsList class="w-full">
          <TabsTrigger value="basic" class="flex-1">基本信息</TabsTrigger>
          <TabsTrigger value="mapping" class="flex-1">字段映射</TabsTrigger>
          <TabsTrigger value="parse" class="flex-1">响应解析</TabsTrigger>
          <TabsTrigger value="advanced" class="flex-1">高级设置</TabsTrigger>
        </TabsList>

        <TabsContent value="basic" class="space-y-4">
          <div class="space-y-2">
            <Label for="qi-type">接口分类</Label>
            <Select v-model="form.categoryId">
              <SelectTrigger id="qi-type">
                <SelectValue placeholder="选择分类" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  v-for="c in categories ?? []"
                  :key="c.id"
                  :value="c.id"
                >
                  {{ c.label }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="space-y-2">
            <Label for="qi-name">名称</Label>
            <Input id="qi-name" v-model="form.name" placeholder="如 沪深股票列表" />
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-2">
              <Label for="qi-endpoint">调用路径</Label>
              <Input
                id="qi-endpoint"
                v-model="form.endpoint"
                placeholder="/api/ashare/list（SDK 时为函数名）"
              />
            </div>
            <div class="space-y-2">
              <Label for="qi-method">HTTP 方法</Label>
              <Select v-model="form.httpMethod">
                <SelectTrigger id="qi-method">
                  <SelectValue placeholder="不设置" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">不设置</SelectItem>
                  <SelectItem v-for="m in HTTP_METHODS" :key="m" :value="m">
                    {{ m }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div class="space-y-2">
            <Label>资产类别（可多选）</Label>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="o in ASSET_CLASS_OPTIONS"
                :key="o.value"
                type="button"
                :aria-pressed="form.assetClass.includes(o.value)"
                @click="toggleAssetClass(o.value)"
                :class="
                  form.assetClass.includes(o.value)
                    ? 'rounded-full border border-primary bg-primary px-3 py-1 text-sm text-primary-foreground transition-colors'
                    : 'rounded-full border border-input bg-background px-3 py-1 text-sm transition-colors hover:bg-accent hover:text-accent-foreground'
                "
              >
                {{ o.label }}
              </button>
            </div>
            <p class="text-xs text-muted-foreground">
              可多选：勾选的类别决定该接口参与哪些「同步选源批次」调用；证券主数据的资产类别由代码前缀自动识别，不以本栏为准。
            </p>
          </div>

          <div class="flex items-center justify-between rounded-md border p-3">
            <Label for="qi-enabled" class="text-sm">启用</Label>
            <Switch id="qi-enabled" v-model="form.enabled" />
          </div>
        </TabsContent>

        <TabsContent value="mapping" class="space-y-3">
          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-2">
              <Label for="qi-resp-code">响应代码字段</Label>
              <Input
                id="qi-resp-code"
                v-model="form.respCodeField"
                placeholder="默认 code；数组行填下标 0"
              />
            </div>
            <div class="space-y-2">
              <Label for="qi-resp-price">响应价格字段</Label>
              <Input
                id="qi-resp-price"
                v-model="form.respPriceField"
                placeholder="默认 price；数组行填下标"
              />
            </div>
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-2">
              <Label for="qi-resp-name">响应名称字段</Label>
              <Input
                id="qi-resp-name"
                v-model="form.respNameField"
                placeholder="默认 name；数组行填下标 1"
              />
            </div>
            <div class="space-y-2">
              <Label for="qi-resp-exchange">响应交易所字段</Label>
              <Input
                id="qi-resp-exchange"
                v-model="form.respExchangeField"
                placeholder="如 exchange / market，缺省按代码前缀推断"
              />
            </div>
          </div>
          <p class="text-xs text-muted-foreground">
            用途选「证券列表（MASTER_LIST）」时，主数据同步按此接口拉取全市场代码/名称/
            交易所（配置驱动，换数据源只改配置）；证券的资产类型由代码前缀自动识别，不以本栏为准。
            若响应为数组行（如 <code class="font-mono">["code","name"]</code>），代码/名称字段填位置下标（如{' '}
            <code class="font-mono">0</code>/<code class="font-mono">1</code>）。
          </p>
        </TabsContent>

        <TabsContent value="parse" class="space-y-3">
          <div class="space-y-2">
            <Label for="qi-rp-format">响应格式</Label>
            <Select v-model="form.rpFormat">
              <SelectTrigger id="qi-rp-format">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="o in RP_FORMAT_OPTIONS" :key="o.value" :value="o.value">
                  {{ o.label }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <template v-if="form.rpFormat === 'text_split'">
            <div class="grid grid-cols-2 gap-4">
              <div class="space-y-2">
                <Label for="qi-rp-encoding">编码</Label>
                <Input
                  id="qi-rp-encoding"
                  v-model="form.rpEncoding"
                  placeholder="utf-8（腾讯财经填 gbk）"
                />
              </div>
              <div class="space-y-2">
                <Label for="qi-rp-sep">分隔符</Label>
                <Input id="qi-rp-sep" v-model="form.rpSep" placeholder="~" />
              </div>
            </div>
            <div class="space-y-2">
              <Label for="qi-rp-line-regex">行提取正则</Label>
              <Input
                id="qi-rp-line-regex"
                v-model="form.rpLineRegex"
                placeholder='v_(\w+)="([^"]*)"'
              />
            </div>
          </template>

          <div class="space-y-2">
            <Label for="qi-rp-code-param">代码参数名</Label>
            <Input
              id="qi-rp-code-param"
              v-model="form.rpCodeParam"
              placeholder="code（腾讯财经填 q）"
            />
          </div>

          <div class="space-y-2">
            <Label for="qi-rp-code-prefix">代码前缀补全</Label>
            <Select
              :model-value="form.rpCodePrefix || 'none'"
              @update:model-value="
                (v: string) => (form.rpCodePrefix = v === 'none' ? '' : v)
              "
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
            <p class="text-xs text-muted-foreground">
              选「自动」后，位数感知补全：5 位纯数字补 hk（港股，00700→hk00700）；
              6 位纯数字按首位推断 sh/sz/bj 裸拼（A股/场内基金，如 600519→sh600519、
              000001→sz000001、510300→sh510300，腾讯/新浪风格）；
              已带前缀（sh600519/hk00700）或非数字（AAPL）原样发送，绝不重复加字母。
              东方财富等直接吃纯数字代码的接口保持「原样」即可。
            </p>
          </div>

          <p class="text-xs text-muted-foreground">
            响应格式选「文本分隔」时，按 sep 拆分每行、按 line_regex 提取带前缀代码（group1）与内容（group2）；
            代码前缀（sh/sz/hk/us）会被保留用于归一化。编码默认 utf-8（腾讯财经需 gbk），
            代码参数名默认 code（腾讯财经为 q，且调用路径请以 <code class="font-mono">q=</code> 结尾以走内联形态）。
          </p>
        </TabsContent>

        <TabsContent value="advanced" class="space-y-4">
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <Label for="qi-params">参数模板</Label>
              <Button variant="ghost" size="sm" @click="addParamRow">
                <Plus class="mr-1 h-3.5 w-3.5" /> 添加参数
              </Button>
            </div>
            <p v-if="form.params.length === 0" class="text-xs text-muted-foreground">
              暂无可编辑参数，点击「添加参数」新增键值对（如 type / region）
            </p>
            <div class="space-y-2">
              <div
                v-for="(row, idx) in form.params"
                :key="idx"
                class="flex items-center gap-2"
              >
                <Input class="w-2/5" v-model="row.key" placeholder="参数名" />
                <Input class="flex-1" v-model="row.value" placeholder="参数值" />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="删除参数"
                  @click="removeParamRow(idx)"
                >
                  <Trash2 class="h-4 w-4" />
                </Button>
              </div>
            </div>
            <p class="text-xs text-muted-foreground">
              这些参数会作为查询条件随每次调用发送（如 iTick 的 <code class="font-mono">type</code>{' '}
              / <code class="font-mono">region</code>）；空值参数在请求时自动忽略。
            </p>
          </div>

          <div class="space-y-2">
            <Label for="qi-desc">描述</Label>
            <Textarea
              id="qi-desc"
              v-model="form.description"
              placeholder="可选，备注该接口用途"
              :rows="3"
            />
          </div>

          <div class="grid grid-cols-3 gap-4">
            <div class="space-y-2">
              <Label for="qi-timeout">超时(秒)</Label>
              <Input
                id="qi-timeout"
                v-model="form.timeout"
                type="number"
                placeholder="可选"
              />
            </div>
            <div class="space-y-2">
              <Label for="qi-retry">重试次数</Label>
              <Input
                id="qi-retry"
                v-model="form.retryCount"
                type="number"
                placeholder="可选"
              />
            </div>
            <div class="space-y-2">
              <Label for="qi-rate">频率限制</Label>
              <Input
                id="qi-rate"
                v-model="form.rateLimit"
                placeholder="如 100/min"
              />
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <DialogFooter>
        <Button variant="outline" @click="emit('openChange', false)">取消</Button>
        <Button :disabled="pending()" @click="handleSubmit">
          <Loader2 v-if="pending()" class="mr-2 h-4 w-4 animate-spin" />
          保存
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>