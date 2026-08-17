<script setup lang="ts">
/**
 * modules/holdings/components/InlinePriceEditor.vue — 持仓页现价内联编辑
 *
 * 平移自 React 版 web/src/features/security-price/inline-price-editor.tsx。
 *
 * PRD §7.2【B】：持仓列表只读，但「现价」支持内联编辑（调 security-price API）。
 * 点击现价进入输入态，回车/失焦保存，Esc 取消，保存后触发后端重算。
 */
import { nextTick, ref, useTemplateRef, type ComponentPublicInstance } from 'vue';
import { Check, LoaderCircle, Pencil, X } from 'lucide-vue-next';
import { Input } from '@/components/ui/input';
import { useUpsertSecurityPrice } from '../composables/use-security-prices';
import { toIsoDate } from '@/lib/constants';
import { formatCurrency } from '@/lib/utils';

const props = defineProps<{
  /** 组合 id */
  portfolioId: string;
  /** 标的 id */
  securityId: string;
  /** 当前现价（number，来自持仓推导） */
  value: number;
  /** 现价日期（用于展示估值标识） */
  priceAsOf?: string | null;
  /** 估值标识：COST_BASED 表示无现价记录 */
  flag?: string;
  class?: string;
}>();

const editing = ref(false);
const draft = ref('');
// Input 为 SFC 包装组件，模板 ref 得到的是组件实例；单根组件经 $el 取原生 input 元素
const inputRef = useTemplateRef<ComponentPublicInstance>('inputRef');
const { mutate: mutateUpsert, isPending: upsertPending } =
  useUpsertSecurityPrice();

/** 进入编辑态后聚焦并全选（对齐 React 版 useEffect 行为） */
async function startEdit(): Promise<void> {
  draft.value = String(props.value);
  editing.value = true;
  await nextTick();
  const inputEl = inputRef.value?.$el as HTMLInputElement | undefined;
  inputEl?.focus();
  inputEl?.select();
}

function cancel(): void {
  editing.value = false;
  draft.value = '';
}

function save(): void {
  const price = Number(draft.value);
  if (!draft.value || !Number.isFinite(price) || price <= 0) {
    cancel();
    return;
  }
  mutateUpsert(
    {
      portfolioId: props.portfolioId,
      payload: {
        securityId: props.securityId,
        asOf: toIsoDate(new Date()),
        price,
      },
    },
    {
      onSettled: () => {
        editing.value = false;
        draft.value = '';
      },
    },
  );
}
</script>

<template>
  <!-- 编辑态：数字输入 + 保存/取消按钮 -->
  <div v-if="editing" :class="props.class">
    <div class="flex items-center gap-1">
      <Input
        ref="inputRef"
        v-model="draft"
        type="number"
        step="0.000001"
        min="0"
        class="h-7 w-24 px-2 text-right text-sm tabular-nums"
        @keydown.enter="save"
        @keydown.escape="cancel"
        @blur="save"
      />
      <LoaderCircle
        v-if="upsertPending"
        class="h-3.5 w-3.5 animate-spin text-muted-foreground"
      />
      <button
        type="button"
        class="text-green-600 hover:text-green-700"
        aria-label="保存价格"
        :disabled="upsertPending"
        @click="save"
      >
        <Check class="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground"
        aria-label="取消"
        :disabled="upsertPending"
        @click="cancel"
      >
        <X class="h-3.5 w-3.5" />
      </button>
    </div>
  </div>

  <!-- 展示态：现价 + 悬停铅笔图标，点击进入编辑 -->
  <div v-else :class="props.class">
    <button
      type="button"
      class="group inline-flex items-center gap-1 rounded px-1 py-0.5 text-right font-mono tabular-nums hover:bg-accent"
      :title="
        flag === 'COST_BASED' || !priceAsOf
          ? '暂无现价记录，当前按成本估值，点击录入现价'
          : `现价日期 ${priceAsOf}，点击修改`
      "
      @click="startEdit"
    >
      {{ formatCurrency(value) }}
      <Pencil
        class="h-3 w-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
      />
    </button>
  </div>
</template>
