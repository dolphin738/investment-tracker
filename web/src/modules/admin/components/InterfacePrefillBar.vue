<script setup lang="ts">
/**
 * modules/admin/components/InterfacePrefillBar.vue — 「字段映射」页签的一键预填区
 *
 * 从 QuoteInterfaceDialog.vue 抽出（行数治理，同 InterfaceResponseParseFields /
 * InterfaceAdvancedSettings）：编辑态走试调端点（有接口 id），新增态走实调预览端点
 * （SDK / HTTPS 接入方式均可，不依赖已存接口），两条路径统一把 raw 首行转为字段
 * 映射行并写回 form.fieldRows（仅预填映射，不做 params 模板生成）。
 *
 * HTTPS 新增态额外给出「探测用测试代码」小输入框：内联形态（调用路径以 = 结尾，
 * 如腾讯财经 q=）没有代码拿不到数据，语义同接口测试面板的「代码」框（逗号分隔）。
 * SDK 场景不显示该输入框，避免打扰。
 */
import { computed, ref } from 'vue';
import { Loader2, Wand2 } from 'lucide-vue-next';
import { toast } from '@/composables/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { prefillRowsFromInterface } from '../composables/use-quote-interface';
import { useQuoteProviders } from '../composables/use-quote-provider';
import {
  buildResponseParse,
  collectParams,
  type FormState,
} from '../utils/quote-interface-form';

const props = defineProps<{
  /** 父级表单（响应式对象）：读取 endpoint / httpMethod / rp* 并写回 fieldRows */
  form: FormState;
  providerId: string;
  /** 编辑态接口 id；null = 新增态 */
  editingId: string | null;
}>();

const loading = ref(false);
const warnings = ref<string[]>([]);
/** 探测用测试代码（仅 HTTPS 新增态使用）：逗号分隔 */
const probeCodes = ref('');

const { data: providers } = useQuoteProviders();
const currentProvider = computed(
  () => providers.value?.find((p) => p.id === props.providerId) ?? null,
);
/** 当前提供方是否 SDK 接入（新增态实调预览：调用路径为 akshare 函数名） */
const isSdkProvider = computed(
  () => currentProvider.value?.access_method === 'sdk',
);
/** 当前提供方是否 HTTPS 接入（新增态实调预览：调用路径为相对 base_url 的路径） */
const isHttpsProvider = computed(
  () => currentProvider.value?.access_method === 'https',
);
/** 预填可用性：新增态需 endpoint 已填且接入方式支持实调（SDK / HTTPS）；
 * 编辑态沿用试调路径恒可用 */
const enabled = computed(() =>
  props.editingId
    ? true
    : Boolean(props.form.endpoint.trim()) &&
      (isSdkProvider.value || isHttpsProvider.value),
);
/** 禁用原因（title 提示；空串 = 可用） */
const disabledReason = computed(() => {
  if (props.editingId) return '';
  if (!props.form.endpoint.trim())
    return '请先在基本信息填写调用路径（SDK 时为 akshare 函数名，HTTPS 时为相对路径）';
  if (!isSdkProvider.value && !isHttpsProvider.value)
    return '请先选择提供方（当前接入方式不支持实调预填）';
  return '';
});

/** 测试代码输入 → 代码数组（去空白项；空输入返回 undefined，即不传 codes） */
function parseProbeCodes(): string[] | undefined {
  const codes = probeCodes.value
    .split(/[,，]/)
    .map((c) => c.trim())
    .filter(Boolean);
  return codes.length ? codes : undefined;
}

async function handlePrefill(): Promise<void> {
  if (loading.value || !enabled.value) return;
  loading.value = true;
  try {
    const pre = await prefillRowsFromInterface({
      editingId: props.editingId,
      endpoint: props.form.endpoint.trim(),
      providerId: props.providerId,
      params: collectParams(props.form),
      // HTTPS 侧三件套：解析协议 / HTTP 方法 / 探测代码（SDK 侧后端忽略）
      responseParse: buildResponseParse(props.form) ?? {},
      httpMethod:
        props.form.httpMethod && props.form.httpMethod !== '__none__'
          ? props.form.httpMethod
          : null,
      codes: parseProbeCodes(),
    });
    warnings.value = pre.warnings;
    if (pre.rows.length === 0) {
      toast.error(pre.warnings[0] ?? '试调结果无可提取的列');
      return;
    }
    props.form.fieldRows = pre.rows;
    toast.success(`已按试调结果预填 ${pre.rows.length} 个字段，请人工校正后保存`);
  } catch (e) {
    toast.error(`预填请求异常：${(e as Error).message}`);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center justify-between gap-2">
      <p class="text-xs text-muted-foreground">
        可先在接口测试面板试调，或在此一键预填后人工校正
      </p>
      <Button
        variant="outline"
        size="sm"
        :disabled="!enabled || loading"
        :title="disabledReason"
        @click="handlePrefill"
      >
        <Loader2 v-if="loading" class="mr-1 h-3.5 w-3.5 animate-spin" />
        <Wand2 v-else class="mr-1 h-3.5 w-3.5" />
        一键预填
      </Button>
    </div>

    <!-- 探测用测试代码：仅 HTTPS 新增态显示（内联 q= 形态必填，其它形态可留空） -->
    <div v-if="!editingId && isHttpsProvider" class="space-y-1">
      <Label for="qi-probe-codes">探测用测试代码（逗号分隔，可留空）</Label>
      <Input
        id="qi-probe-codes"
        v-model="probeCodes"
        placeholder="如 sh600519,sz000001（调用路径以 = 结尾时必填）"
      />
    </div>
    <p v-if="!editingId && isHttpsProvider" class="text-xs text-muted-foreground">
      新增态可直接实调预填：填写调用路径（相对提供方 base_url；以 = 结尾为内联代码形态）后点击一键预填
    </p>
    <p v-else-if="!editingId && isSdkProvider" class="text-xs text-muted-foreground">
      新增态可直接实调预填：填写调用路径（akshare 函数名）后点击一键预填
    </p>
    <p v-else-if="!editingId" class="text-xs text-muted-foreground">
      当前提供方接入方式不支持新增态实调预填，保存后即可试调并一键预填
    </p>

    <ul v-if="warnings.length > 0" class="space-y-0.5 text-xs text-muted-foreground">
      <li v-for="(w, i) in warnings" :key="i">- {{ w }}</li>
    </ul>
  </div>
</template>
