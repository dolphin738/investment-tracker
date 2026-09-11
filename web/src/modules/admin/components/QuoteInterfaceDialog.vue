<script setup lang="ts">
/**
 * modules/admin/components/QuoteInterfaceDialog.vue — 提供方接口新增/编辑对话框
 *
 * 平移自 React 版 features/admin/quote-interface-dialog.tsx，行为契约一致。
 * 内含 4 个 Tabs 页签：基本信息 / 字段映射 / 响应解析 / 高级设置。
 * - 「字段映射」为可增删行映射表格（InterfaceFieldMappingTable），slot 下拉 /
 *   类型 / 单位来自契约端点（useResponseFieldSchema），支持按分类必填提示与一键预填
 *   （方案 §7 四层动态性）。
 * - 「响应解析」「高级设置」页签内容抽至 InterfaceResponseParseFields /
 *   InterfaceAdvancedSettings；表单模型与 payload 组装见 utils/quote-interface-form.ts；
 *   映射行逻辑见 utils/response-fields.ts。
 * 不含 direction（后端落库，UI 暂不暴露）。
 */
import { computed, reactive, ref, watch } from 'vue';
import { Loader2, Wand2 } from 'lucide-vue-next';
import { toast } from '@/composables/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { type HttpMethod, type QuoteInterface } from '@/api/quote-interface.api';
import { useInterfaceCategories } from '../composables/use-interface-category';
import {
  prefillRowsFromInterface,
  useCreateInterface,
  useResponseFieldSchema,
  useUpdateInterface,
} from '../composables/use-quote-interface';
import { useQuoteProviders } from '../composables/use-quote-provider';
import InterfaceFieldMappingTable from './InterfaceFieldMappingTable.vue';
import InterfaceResponseParseFields from './InterfaceResponseParseFields.vue';
import InterfaceAdvancedSettings from './InterfaceAdvancedSettings.vue';
import {
  collectParams,
  buildSubmitPayload,
  hasLegacyMirror,
  toForm,
  type FormState,
} from '../utils/quote-interface-form';
import { emptyFieldRow, missingRequiredSlots } from '../utils/response-fields';

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

const props = defineProps<{
  open: boolean;
  providerId: string;
  /** 传入则编辑模式，否则新增 */
  editing: QuoteInterface | null;
}>();

const emit = defineEmits<{ openChange: [open: boolean] }>();

const { data: categories } = useInterfaceCategories();
const { data: fieldSchema } = useResponseFieldSchema();
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
      prefillWarnings.value = [];
      activeTab.value = 'basic';
    }
  },
  { immediate: true },
);

const pending = () => createMut.isPending.value || updateMut.isPending.value;

/** 切换资产类别多选（勾选/取消单个） */
function toggleAssetClass(value: string): void {
  // 整体替换而非原地 splice/push：与表单重置（Object.assign 整体替换）路径一致，
  // 强制走响应式 set trap，保证 chip 选中态可靠刷新。
  const next = new Set(form.assetClass);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  form.assetClass = [...next];
}

// —— 字段映射行增删改（行数据由 form 持有，表格组件通过 emit 回传）——
function addFieldRow(): void {
  form.fieldRows.push(emptyFieldRow());
}
function removeFieldRow(idx: number): void {
  form.fieldRows.splice(idx, 1);
}
function updateFieldRow(idx: number, patch: Partial<FormState['fieldRows'][number]>): void {
  form.fieldRows[idx] = { ...form.fieldRows[idx], ...patch };
}

// —— 契约校验提示：按分类计算缺失的必填 slot（页签红点 + 页签内文案）——
const missingSlots = computed(() =>
  missingRequiredSlots(form.fieldRows, fieldSchema.value ?? null, form.categoryId),
);

// —— 一键预填：编辑态走试调端点，新增态走实调预览端点（仅 SDK），统一从 raw 生成映射行 ——
const prefillLoading = ref(false);
const prefillWarnings = ref<string[]>([]);

const { data: providers } = useQuoteProviders();
/** 当前提供方是否 SDK 接入（新增态实调预览仅支持 SDK，后端 400 兜底） */
const isSdkProvider = computed(
  () =>
    providers.value?.find((p) => p.id === props.providerId)?.access_method ===
    'sdk',
);
/** 新增态预填可用性：endpoint 已填且提供方为 SDK；编辑态沿用试调路径恒可用 */
const prefillEnabled = computed(() =>
  props.editing ? true : Boolean(form.endpoint.trim()) && isSdkProvider.value,
);
/** 预填按钮禁用原因（title 提示；空串 = 可用） */
const prefillDisabledReason = computed(() => {
  if (props.editing) return '';
  if (!form.endpoint.trim())
    return '请先在基本信息填写调用路径（SDK 时为 akshare 函数名）';
  if (!isSdkProvider.value) return 'HTTPS 提供方暂不支持实调预填，保存后可试调';
  return '';
});

async function handlePrefill(): Promise<void> {
  if (prefillLoading.value || !prefillEnabled.value) return;
  prefillLoading.value = true;
  try {
    // 预填取数下沉 composable：编辑态走试调端点，新增态走实调预览端点（仅 SDK）
    const pre = await prefillRowsFromInterface({
      editingId: props.editing?.id ?? null,
      endpoint: form.endpoint.trim(),
      providerId: props.providerId,
      params: collectParams(form),
    });
    prefillWarnings.value = pre.warnings;
    if (pre.rows.length === 0) {
      toast.error(pre.warnings[0] ?? '试调结果无可提取的列');
      return;
    }
    form.fieldRows = pre.rows;
    toast.success(`已按试调结果预填 ${pre.rows.length} 个字段，请人工校正后保存`);
  } catch (e) {
    toast.error(`预填请求异常：${(e as Error).message}`);
  } finally {
    prefillLoading.value = false;
  }
}

/** 编辑态且为老数据（response_fields 为 NULL）时，展示旧 4 列只读镜像说明 */
const legacyMirror = computed(() => hasLegacyMirror(props.editing));

function handleSubmit(): void {
  if (!form.categoryId.trim()) {
    toast.error('请选择接口分类');
    return;
  }
  if (!form.name.trim()) {
    toast.error('请填写接口名称');
    return;
  }

  const payload = buildSubmitPayload(form);

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
          <TabsTrigger value="mapping" class="flex-1">
            字段映射
            <span
              v-if="missingSlots.length > 0"
              class="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-destructive"
              aria-label="存在缺失的必填槽位"
            />
          </TabsTrigger>
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
          <!-- 按分类契约的缺必填槽显式提示（保存会被后端 400 拒绝） -->
          <div
            v-if="missingSlots.length > 0"
            class="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
            data-testid="missing-slots-hint"
          >
            当前分类还缺少必填槽位：{{ missingSlots.join('、') }}；请为对应字段选择语义槽位后再保存
          </div>

          <!-- 一键预填：编辑态先试调 / 新增态实调预览 → 生成映射 → 人工校正 -->
          <div class="flex items-center justify-between gap-2">
            <p class="text-xs text-muted-foreground">
              可先在接口测试面板试调，或在此一键预填后人工校正
            </p>
            <Button
              variant="outline"
              size="sm"
              :disabled="!prefillEnabled || prefillLoading"
              :title="prefillDisabledReason"
              @click="handlePrefill"
            >
              <Loader2 v-if="prefillLoading" class="mr-1 h-3.5 w-3.5 animate-spin" />
              <Wand2 v-else class="mr-1 h-3.5 w-3.5" />
              一键预填
            </Button>
          </div>
          <p v-if="!props.editing && !isSdkProvider" class="text-xs text-muted-foreground">
            HTTPS 提供方暂不支持新增态实调预填，保存后即可试调并一键预填
          </p>
          <p v-else-if="!props.editing" class="text-xs text-muted-foreground">
            新增态可直接实调预填：填写调用路径（akshare 函数名）后点击一键预填
          </p>
          <ul v-if="prefillWarnings.length > 0" class="space-y-0.5 text-xs text-muted-foreground">
            <li v-for="(w, i) in prefillWarnings" :key="i">- {{ w }}</li>
          </ul>

          <InterfaceFieldMappingTable
            :rows="form.fieldRows"
            :schema="fieldSchema ?? null"
            :category-id="form.categoryId"
            @add-row="addFieldRow"
            @remove-row="removeFieldRow"
            @update-row="updateFieldRow"
          />

          <!-- 旧 4 列只读镜像说明：保存时由后端按映射表自动派生（Expand 双写） -->
          <div v-if="legacyMirror" class="rounded-md border p-2 text-xs text-muted-foreground">
            <p>
              旧版响应字段（代码/价格/名称/交易所列）已成回滚镜像：保存时由后端按上方映射表自动派生，此处只读展示。
            </p>
            <p class="mt-1 font-mono">
              代码={{ form.respCodeField || '(默认 code)' }}；价格={{ form.respPriceField || '(默认 price)' }}；名称={{ form.respNameField || '(默认 name)' }}；交易所={{ form.respExchangeField || '(未配置)' }}
            </p>
          </div>

          <p class="text-xs text-muted-foreground">
            修改映射仅影响后续同步，不回填历史数据。若响应为数组行（如{' '}
            <code class="font-mono">["code","name"]</code>），source 填位置下标
            （如 <code class="font-mono">0</code> / <code class="font-mono">1</code>）；
            含点的列名用转义（如 <code class="font-mono">2024\.06</code>）。
          </p>
        </TabsContent>

        <TabsContent value="parse" class="space-y-3">
          <InterfaceResponseParseFields :form="form" />
        </TabsContent>

        <TabsContent value="advanced">
          <InterfaceAdvancedSettings :form="form" />
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
