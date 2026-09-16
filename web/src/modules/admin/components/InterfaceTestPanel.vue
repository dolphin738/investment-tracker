<script setup lang="ts">
/**
 * modules/admin/components/InterfaceTestPanel.vue — 右栏：单接口测试
 *
 * 平移自 React 版 features/admin/stock-list-test-section.tsx 的 InterfaceTestPanel，行为契约一致。
 * 选接口 → 编辑参数（键值对增删） → 可选 codes → 执行 → 查看原始响应与解析结果（不持久化）。
 * 原始响应支持查找高亮 / 上下跳转 / 复制全部。
 *
 * 纯位置拆分：结果展示区块（状态 / 错误 / 逐槽位命中率 / 原始响应查看器）已抽到
 * InterfaceTestResponseViewer.vue；本文件保留面板外壳（Card）与参数表单。
 */

import { computed, ref, watch } from 'vue';
import {
  Loader2,
  Play,
  Plus,
  Trash2,
} from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useQuoteInterfacesAll } from '../composables/use-quote-interface';
import { useQuoteProviders } from '../composables/use-quote-provider';
import { useInterfaceCategories } from '../composables/use-interface-category';
import { useInterfaceTest } from '../composables/use-interface-test';
import type {
  InterfaceTestResponse,
  QuoteInterface,
} from '@/api/quote-interface.api';
import InterfaceTestResponseViewer from './InterfaceTestResponseViewer.vue';

const props = defineProps<{
  /** 右侧待测试代码（左栏「填入测试」追加，逗号/空格/换行分隔） */
  codesText: string;
}>();
const emit = defineEmits<{ codesChange: [value: string] }>();

interface ParamRow {
  key: string;
  value: string;
  /** 模板默认值：仅作输入框占位提示，不实际填入（以 placeholder 展示） */
  defaultValue: string;
  /** 参数输入提示（针对易填错的参数，如报告期），为空不展示 */
  hint: string;
}

/** 已知参数名的输入提示（针对易填错参数，避免填入非季度末报告期） */
const PARAM_HINTS: Record<string, string> = {
  date: '报告期，形如 20231231（季度末：0331/0630/0930/1231）',
};

/** 按接口（endpoint）覆盖的参数提示：同名参数在不同接口含义不同，优先于 PARAM_HINTS。
 *  如 stock_notice_report（沪深京 A 股公告）的 date 为任意指定日期（不限季度末），
 *  symbol 为公告类别枚举。 */
const ENDPOINT_PARAM_HINTS: Record<string, Record<string, string>> = {
  stock_notice_report: {
    symbol:
      '可选：全部、重大事项、财务报告、融资公告、风险提示、资产重组、信息变更、持股变动',
    date: '指定日期，形如 20240613',
  },
  stock_history_dividend_detail: {
    symbol: '股票代码，如 600012',
    indicator: '可选：分红、配股',
    date: '可选，形如 1994-12-24；留空=全量历史',
  },
  stock_zh_a_hist: {
    symbol: "股票代码，纯数字（如 000001）；历史回补由系统按证券代码自动填入",
    period: "周期：daily（日）、weekly（周）、monthly（月）",
    start_date: "开始日期，形如 20240101；留空=用函数默认（19700101，全量）",
    end_date: "结束日期，形如 20240528；留空=用函数默认（20500101）",
    adjust: "复权：留空=不复权；qfq=前复权；hfq=后复权",
    timeout: "可选，请求超时秒数；留空=不设置",
  },
  stock_zh_a_hist_tx: {
    symbol: "股票代码，带市场前缀（如 sz000001）或纯数字（如 000001）；历史回补由系统按证券代码自动填入",
    start_date: "开始日期，形如 20240101；留空=用函数默认（19000101，全量）",
    end_date: "结束日期，形如 20240528；留空=用函数默认（20500101）",
    adjust: "复权：留空=不复权；qfq=前复权；hfq=后复权",
    timeout: "可选，请求超时秒数；留空=不设置",
  },
};

/** 识别接口参数模板里的占位符默认值（如 string / 示例 / example），留空时不作为真实参数发送 */
function isPlaceholderValue(v: string): boolean {
  const s = v.trim().toLowerCase();
  return ['string', '示例', 'example', '占位', '占位符', 'placeholder', 'xxx'].includes(s);
}

const { data: interfaces } = useQuoteInterfacesAll();
const { data: providers } = useQuoteProviders();
const { data: categories } = useInterfaceCategories();
const testMut = useInterfaceTest();

// 提供方 id → 名称：接口下拉展示接口归属（如「A股行情（小熊同学）」）
const providerNameById = computed(() => {
  const m = new Map<string, string>();
  (providers.value ?? []).forEach((p) => m.set(p.id, p.name));
  return m;
});

const selectedId = ref<string | null>(null);
const paramRows = ref<ParamRow[]>([]);
const result = ref<InterfaceTestResponse | null>(null);

// 查找高亮 / 上下跳转状态：父级持有，handleTest 时重置，v-model 下发至
// InterfaceTestResponseViewer（原始响应查看器）以复用同一份查找态。
const findQuery = ref('');
const currentMatch = ref(0);

/** 与后端选源 AND 逻辑一致：接口启用 AND 所属提供方启用（provider.enabled 为父级总闸）。 */
const enabledInterfaces = computed<QuoteInterface[]>(
  () =>
    (interfaces.value ?? []).filter((i) => {
      const provider = (providers.value ?? []).find((p) => p.id === i.provider_id);
      return i.enabled && (provider?.enabled ?? false);
    }),
);

/**
 * 接口下拉按所属分类分组：外层按分类 sort_order 排序，
 * 组内接口保持 enabledInterfaces 的原有顺序；未分类（或分类已删）
 * 的接口归入末尾「未分类」组。
 */
const groupedInterfaces = computed<Array<{ label: string; items: QuoteInterface[] }>>(
  () => {
    const ordered = [...(categories.value ?? [])].sort(
      (a, b) => a.sort_order - b.sort_order,
    );
    const groups: Array<{ label: string; items: QuoteInterface[] }> = [];
    const indexById = new Map<string, number>();
    ordered.forEach((c) => {
      indexById.set(c.id, groups.length);
      groups.push({ label: c.label, items: [] });
    });
    for (const itf of enabledInterfaces.value) {
      const idx =
        itf.category_id != null ? indexById.get(itf.category_id) : undefined;
      if (idx === undefined) {
        let fallback = groups.find((g) => g.label === '未分类');
        if (!fallback) {
          fallback = { label: '未分类', items: [] };
          groups.push(fallback);
        }
        fallback.items.push(itf);
      } else {
        groups[idx].items.push(itf);
      }
    }
    return groups.filter((g) => g.items.length > 0);
  },
);

// 切换接口时以其 params 模板初始化可编辑行
watch(
  () => [selectedId.value, interfaces.value],
  () => {
    if (!selectedId.value) {
      paramRows.value = [];
      return;
    }
    const itf = (interfaces.value ?? []).find(
      (i) => i.id === selectedId.value,
    );
    const params = (itf?.params ?? {}) as Record<string, unknown>;
    // 提示优先级：接口级覆盖（ENDPOINT_PARAM_HINTS）> 参数名兜底（PARAM_HINTS）
    const endpointHints = ENDPOINT_PARAM_HINTS[itf?.endpoint ?? ''] ?? {};
    paramRows.value = Object.entries(params).map(([k, v]) => ({
      key: k,
      value: '',
      defaultValue: v == null ? '' : String(v),
      hint: endpointHints[k] ?? PARAM_HINTS[k] ?? '',
    }));
  },
  { immediate: true },
);

function updateRow(idx: number, patch: Partial<ParamRow>): void {
  paramRows.value[idx] = { ...paramRows.value[idx], ...patch };
}
function addRow(): void {
  paramRows.value.push({ key: '', value: '', defaultValue: '', hint: '' });
}
function removeRow(idx: number): void {
  paramRows.value.splice(idx, 1);
}

function handleTest(): void {
  if (!selectedId.value) return;
  findQuery.value = '';
  currentMatch.value = 0;
  const params: Record<string, unknown> = {};
  paramRows.value.forEach((r) => {
    const k = r.key.trim();
    if (!k) return;
    const candidate =
      r.value.trim() !== '' ? r.value.trim() : (r.defaultValue ?? '').trim();
    // 空值或模板占位符（如 string / 示例）不发送，避免把上游过滤成空列表
    if (!candidate || isPlaceholderValue(candidate)) return;
    params[k] = candidate;
  });
  const codes = props.codesText
    .split(/[\s,，]+/)
    .map((c) => c.trim())
    .filter(Boolean);
  result.value = null;
  testMut.mutate(
    { interfaceId: selectedId.value, params, codes: codes.length ? codes : undefined },
    { onSuccess: (data) => (result.value = data) },
  );
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="text-base">接口测试</CardTitle>
      <CardDescription>
        选择接口 → 编辑参数 → 执行 → 查看原始响应与逐槽位命中率（不持久化）
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-4">
      <div class="space-y-1.5">
        <label class="text-sm font-medium">接口</label>
        <Select :model-value="selectedId ?? undefined" @update:model-value="selectedId = $event">
          <SelectTrigger>
            <SelectValue placeholder="选择要测试的接口（仅启用）" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup v-for="grp in groupedInterfaces" :key="grp.label">
              <SelectLabel>{{ grp.label }}</SelectLabel>
              <SelectItem v-for="it in grp.items" :key="it.id" :value="it.id">
                {{ it.name }}（{{ providerNameById.get(it.provider_id) ?? '未知提供方' }}）
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <!-- 参数：可编辑键值对（支持增删） -->
      <div class="space-y-1.5">
        <div class="flex items-center justify-between">
          <label class="text-sm font-medium">参数</label>
          <Button variant="ghost" size="sm" @click="addRow">
            <Plus class="mr-1 h-3.5 w-3.5" /> 添加参数
          </Button>
        </div>
        <p v-if="paramRows.length === 0" class="text-xs text-muted-foreground">
          该接口无默认参数模板
        </p>
        <div class="space-y-2">
          <div v-for="(row, idx) in paramRows" :key="idx" class="space-y-1">
            <div class="flex items-center gap-2">
              <Input
                class="w-2/5"
                placeholder="参数名"
                v-model="row.key"
              />
              <Input
                class="flex-1"
                :placeholder="
                  row.defaultValue
                    ? isPlaceholderValue(row.defaultValue)
                      ? `示例值（留空不发送）：${row.defaultValue}`
                      : `默认：${row.defaultValue}`
                    : '参数值'
                "
                v-model="row.value"
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label="删除参数"
                @click="removeRow(idx)"
              >
                <Trash2 class="h-4 w-4" />
              </Button>
            </div>
            <p v-if="row.hint" class="pl-1 text-xs text-muted-foreground">
              {{ row.hint }}
            </p>
          </div>
        </div>
      </div>

      <!-- codes（可选） -->
      <div class="space-y-1.5">
        <label class="text-sm font-medium">
          代码（可选，逗号 / 空格 / 换行分隔）
        </label>
        <Textarea
          :rows="2"
          :placeholder="'如 600519,000001'"
          :model-value="props.codesText"
          @update:model-value="$emit('codesChange', $event ?? '')"
        />
      </div>

      <Button
        :disabled="!selectedId || testMut.isPending.value"
        @click="handleTest"
      >
        <Play
          :class="cn('mr-2 h-4 w-4', testMut.isPending.value && 'animate-spin')"
        />
        {{ testMut.isPending.value ? '测试中…' : '执行测试' }}
      </Button>

      <!-- 结果展示（状态 / 错误 / 逐槽位命中率 / 原始响应查看器） -->
      <InterfaceTestResponseViewer
        :result="result"
        v-model:find-query="findQuery"
        v-model:current-match="currentMatch"
      />
    </CardContent>
  </Card>
</template>
