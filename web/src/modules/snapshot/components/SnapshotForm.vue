<script setup lang="ts">
/**
 * modules/snapshot/components/SnapshotForm.vue — 资产快照录入/编辑表单（PRD §7.3）
 *
 * 平移自 React 版 web/src/features/snapshot/snapshot-form.tsx，行为契约一致：
 * - 字段：日期（不可未来）/ 总资产* / 持仓市值 / 现金余额 / 备注
 * - 选择日期后展示「该日系统自动计算值为 ¥xxx，保存后将取代」
 * - 编辑语义：
 *   - 手工记录（source=MANUAL）→ PATCH 更新
 *   - 自动记录（source=DERIVED）或无记录 → POST upsert（保存即变手工）
 *
 * 表单校验 vee-validate + zod（schema 见 ../features/snapshot-schema，
 * resolver 走 lib/zod-typed-schema 适配层）。
 */

import { computed, watch } from 'vue';
import { useForm, useField } from 'vee-validate';
import { AlertTriangle, Loader2 } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  useNavTotalAssetMap,
  useUpdateSnapshot,
  useUpsertSnapshot,
} from '../composables/use-snapshots';
import { snapshotSchema, type SnapshotFormValues } from '../features/snapshot-schema';
import { zodToTypedSchema } from '@/lib/zod-typed-schema';
import { toIsoDate } from '@/lib/constants';
import { formatCurrency } from '@/lib/utils';
import type { AssetSnapshot } from '@/lib/types';

const props = defineProps<{
  portfolioId: string;
  /** 传入则编辑（DERIVED 行保存后变 MANUAL），否则新建 */
  snapshot?: AssetSnapshot | null;
  class?: string;
}>();

const emit = defineEmits<{
  /** 保存成功（页面据此关闭弹窗） */
  success: [];
}>();

const today = toIsoDate(new Date());
const upsertMutation = useUpsertSnapshot();
const updateMutation = useUpdateSnapshot();
const isManualEdit = computed(() =>
  Boolean(props.snapshot && props.snapshot.source === 'MANUAL'),
);

const defaultValues = (): SnapshotFormValues => ({
  date: today,
  totalAsset: '',
  marketValue: '',
  cashBalance: '',
  note: '',
});

const { handleSubmit, resetForm } = useForm<SnapshotFormValues>({
  validationSchema: zodToTypedSchema(snapshotSchema),
  initialValues: defaultValues(),
});

const { value: dateValue, errorMessage: dateError } = useField<string>('date');
const { value: totalAsset, errorMessage: totalAssetError } = useField<string>('totalAsset');
const { value: marketValue, errorMessage: marketValueError } = useField<string>('marketValue');
const { value: cashBalance, errorMessage: cashBalanceError } = useField<string>('cashBalance');
const { value: note, errorMessage: noteError } = useField<string>('note');

// snapshot 变化（新建/编辑切换）时重置表单，对齐 React useEffect 行为
watch(
  () => props.snapshot,
  (snapshot) => {
    if (snapshot) {
      resetForm({
        values: {
          date: snapshot.date,
          totalAsset: snapshot.totalAsset ?? '',
          marketValue: snapshot.marketValue ?? '',
          cashBalance: snapshot.cashBalance ?? '',
          note: snapshot.note ?? '',
        },
      });
    } else {
      resetForm({ values: defaultValues() });
    }
  },
  { immediate: true },
);

// 系统自动计算值（用于覆盖提示）：按当前日期精确查单条（AL-054 · Q-1甲）。
// 后端在响应里实时回填 derivedTotalAsset（DERIVED 行 == totalAsset；MANUAL 行为
// computeDerived 结果；计算失败 → null）。精确单日查询 pageSize=1（≤ 后端 @Max(200)）。
const systemValueQuery = useNavTotalAssetMap(
  () => props.portfolioId,
  () => dateValue.value || null,
);
const systemValue = computed(() => systemValueQuery.data.value ?? null);

const onSubmit = handleSubmit((values) => {
  const payload = {
    date: values.date,
    totalAsset: values.totalAsset,
    marketValue: values.marketValue || undefined,
    cashBalance: values.cashBalance || undefined,
    note: values.note || undefined,
  };
  const onOk = () => {
    resetForm({ values: defaultValues() });
    emit('success');
  };

  if (isManualEdit.value && props.snapshot) {
    updateMutation.mutate(
      { portfolioId: props.portfolioId, id: props.snapshot.id, payload },
      { onSuccess: onOk },
    );
  } else {
    // 新建 或 编辑 DERIVED 行 → POST upsert（保存后变手工）
    upsertMutation.mutate(
      { portfolioId: props.portfolioId, payload },
      { onSuccess: onOk },
    );
  }
});

const isPending = computed(
  () => upsertMutation.isPending.value || updateMutation.isPending.value,
);
</script>

<template>
  <form :class="props.class" @submit.prevent="onSubmit">
    <div class="space-y-4">
      <div class="space-y-2">
        <Label for="snapshot-date">日期</Label>
        <Input
          id="snapshot-date"
          v-model="dateValue"
          type="date"
          :max="today"
        />
        <p v-if="dateError" class="text-xs text-destructive">{{ dateError }}</p>
        <!-- 该日已有自动记录提示（SNAP-P0-06 ①：允许选择已有自动记录的日期，此时即为覆盖） -->
        <p v-if="systemValue !== null" class="text-xs text-amber-700">
          ⓘ 该日已有自动记录，将被覆盖
        </p>
      </div>

      <!-- 覆盖提示（§7.3 新建/编辑弹窗：该日系统自动计算值为 ¥x；保存后取代） -->
      <div
        v-if="systemValue !== null"
        class="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800"
      >
        <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          {{ `该日系统自动计算值为 ${formatCurrency(systemValue)}。保存后，您填写的值将取代该日的自动记录（每天只保留一条），并用于净值/XIRR 重算。` }}
        </span>
      </div>

      <div class="space-y-2">
        <Label for="snapshot-asset">当日总资产（元）*</Label>
        <Input
          id="snapshot-asset"
          v-model="totalAsset"
          type="number"
          step="0.01"
          min="0"
          placeholder="0.00"
        />
        <p v-if="totalAssetError" class="text-xs text-destructive">
          {{ totalAssetError }}
        </p>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div class="space-y-2">
          <Label for="snapshot-market">持仓市值（元）</Label>
          <Input
            id="snapshot-market"
            v-model="marketValue"
            type="number"
            step="0.01"
            min="0"
            placeholder="可选"
          />
          <p v-if="marketValueError" class="text-xs text-destructive">
            {{ marketValueError }}
          </p>
        </div>
        <div class="space-y-2">
          <Label for="snapshot-cash">现金余额（元）</Label>
          <Input
            id="snapshot-cash"
            v-model="cashBalance"
            type="number"
            step="0.01"
            min="0"
            placeholder="可选"
          />
          <p v-if="cashBalanceError" class="text-xs text-destructive">
            {{ cashBalanceError }}
          </p>
        </div>
      </div>

      <div class="space-y-2">
        <Label for="snapshot-note">备注（建议填写）</Label>
        <Textarea
          id="snapshot-note"
          v-model="note"
          placeholder="如：月末估值 / 季度盘点"
          :rows="2"
        />
        <p class="text-xs text-muted-foreground">
          ⓘ 建议填写修正原因，便于日后回溯
        </p>
        <p v-if="noteError" class="text-xs text-destructive">{{ noteError }}</p>
      </div>
    </div>

    <div class="mt-6 flex justify-end gap-2">
      <Button type="submit" :disabled="isPending">
        <Loader2 v-if="isPending" class="mr-2 h-4 w-4 animate-spin" />
        保存并重算
      </Button>
    </div>
  </form>
</template>
