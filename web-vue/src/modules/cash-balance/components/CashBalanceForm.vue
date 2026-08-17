<script setup lang="ts">
/**
 * modules/cash-balance/components/CashBalanceForm.vue — 现金余额录入/编辑表单（弹窗内容）
 *
 * 平移自 React 版 features/cashflow/cash-balance-form.tsx，schema 与错误消息逐字一致。
 *
 * 出入金页改版：现金余额从「页面内联输入框」升级为弹窗录入，
 * 新增与编辑复用同一组件（编辑 = 按生效日 upsert 覆盖同一条记录）。
 *
 * 语义约定：
 * - 后端 POST /cash-balances 是 upsert（同 asOf 覆盖旧值），因此编辑态锁定生效日：
 *   若允许改日期，会变成「新建一条 + 旧记录残留」，与用户预期的「改这一条」不符。
 *   确需改日期 → 删除后重新录入（删除同样触发重算）。
 * - 金额允许 0（清空现金），但不允许负数；日期不能为未来（与后端 D1 校验同口径）。
 * - 提交失败不关闭弹窗：保留用户输入并就地显示后端可读错误（含业务码文案）；
 *   全局 toast 由 api-client 拦截器统一负责，此处不重复 toast（避免双弹）。
 *
 * 表单引擎由 react-hook-form + zodResolver 换为 vee-validate + zod，
 * 校验规则与提示文案不变。
 */

import { computed, ref, watch } from 'vue';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { AlertCircle, Loader2 } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useUpsertCashBalance } from '../composables/use-cash-balances';
import { resolveApiErrorMessage } from '@/lib/api-error-message';
import { toIsoDate } from '@/lib/constants';
import { zodToTypedSchema } from '@/lib/zod-typed-schema';
import { formatDate } from '@/lib/utils';
import type { CashBalanceResponse } from '@/api/types';

const cashBalanceSchema = z.object({
  asOf: z
    .string()
    .min(1, '请选择生效日期')
    .refine((v) => v <= toIsoDate(new Date()), '生效日期不能为未来'),
  amount: z.preprocess(
    // Vue 对 type=number 输入的 v-model 会自动把值转为数字，
    // 此处先归一为字符串，保持与 React 版 z.string() 同口径（错误消息不变）
    (v) => (typeof v === 'number' ? String(v) : v),
    z
      .string()
      .min(1, '请输入金额')
      .refine((v) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0;
      }, '金额必须为不小于 0 的数字'),
  ),
  note: z.string().max(200, '备注最多 200 字').optional(),
});

type CashBalanceFormValues = z.infer<typeof cashBalanceSchema>;

const props = defineProps<{
  portfolioId: string;
  /** 传入则为编辑（按生效日覆盖该条），否则为新增 */
  balance?: CashBalanceResponse | null;
  /** 保存成功回调（父级据此关闭弹窗） */
  onSuccess?: (result: CashBalanceResponse) => void;
}>();

const isEdit = computed(() => Boolean(props.balance));
const upsertMutation = useUpsertCashBalance();
const upsertPending = computed(() => upsertMutation.isPending.value);
const today = toIsoDate(new Date());
/** 提交失败的就地错误（弹窗不关，输入不丢） */
const submitError = ref('');

const { handleSubmit, resetForm, errors, defineField } = useForm<CashBalanceFormValues>({
  validationSchema: zodToTypedSchema(cashBalanceSchema),
  initialValues: {
    asOf: props.balance?.asOf ?? today,
    amount: props.balance?.amount ?? '',
    note: props.balance?.note ?? '',
  },
});

const [asOfModel, asOfAttrs] = defineField('asOf');
const [amountModel, amountAttrs] = defineField('amount');
const [noteModel, noteAttrs] = defineField('note');

// 复用同一弹窗在「新增 <-> 编辑某条」之间切换时重置表单与错误
watch(
  () => props.balance,
  (balance) => {
    submitError.value = '';
    if (balance) {
      resetForm({
        values: { asOf: balance.asOf, amount: balance.amount, note: balance.note ?? '' },
      });
    } else {
      resetForm({ values: { asOf: today, amount: '', note: '' } });
    }
  },
  { immediate: true },
);

const onSubmit = handleSubmit((values) => {
  submitError.value = '';
  upsertMutation.mutate(
    {
      portfolioId: props.portfolioId,
      payload: {
        // 编辑态生效日锁定为原记录的 asOf（表单未渲染该输入，值取自回填值）
        asOf: isEdit.value && props.balance ? props.balance.asOf : values.asOf,
        amount: Number(values.amount),
        note: values.note || undefined,
      },
    },
    {
      onSuccess: (data) => {
        if (!isEdit.value) {
          resetForm({ values: { asOf: today, amount: '', note: '' } });
        }
        props.onSuccess?.(data);
      },
      onError: (error) => {
        submitError.value = resolveApiErrorMessage(
          error,
          '现金余额保存失败，请稍后重试',
        );
      },
    },
  );
});
</script>

<template>
  <form @submit="onSubmit">
    <div class="space-y-4">
      <!-- 生效日期：新增可选，编辑锁定（upsert 按 asOf 覆盖，改日期会变成新建） -->
      <div class="space-y-2">
        <Label for="cb-as-of">生效日期</Label>
        <template v-if="isEdit && props.balance">
          <p
            id="cb-as-of"
            class="flex h-9 items-center rounded-md border border-input bg-muted/40 px-3 font-mono text-sm"
          >
            {{ formatDate(props.balance.asOf) }}
          </p>
          <p class="text-xs text-muted-foreground">
            生效日不可修改；如需改日期请删除该条后重新录入。
          </p>
        </template>
        <Input
          v-else
          id="cb-as-of"
          v-model="asOfModel"
          v-bind="asOfAttrs"
          type="date"
          :max="today"
        />
        <p v-if="errors.asOf" class="text-xs text-destructive">{{ errors.asOf }}</p>
      </div>

      <!-- 金额（允许 0 = 清空现金；不允许负数） -->
      <div class="space-y-2">
        <Label for="cb-amount">金额（元）</Label>
        <Input
          id="cb-amount"
          v-model="amountModel"
          v-bind="amountAttrs"
          type="number"
          step="0.01"
          min="0"
          placeholder="0.00"
        />
        <p v-if="errors.amount" class="text-xs text-destructive">{{ errors.amount }}</p>
      </div>

      <!-- 备注 -->
      <div class="space-y-2">
        <Label for="cb-note">备注（可选）</Label>
        <Textarea
          id="cb-note"
          v-model="noteModel"
          v-bind="noteAttrs"
          placeholder="如：券商账户可用余额对账"
          rows="2"
        />
        <p v-if="errors.note" class="text-xs text-destructive">{{ errors.note }}</p>
      </div>

      <p class="text-xs text-muted-foreground">
        保存后自该生效日起前向沿用，并触发净值 / XIRR 重算。
      </p>

      <!-- 提交失败：就地保留原因，弹窗不关闭（不吞错误） -->
      <p
        v-if="submitError"
        role="alert"
        class="flex items-start gap-1.5 rounded-md bg-destructive/10 p-2 text-xs text-destructive"
      >
        <AlertCircle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{{ submitError }}</span>
      </p>
    </div>

    <div class="mt-6 flex justify-end gap-2">
      <Button type="submit" :disabled="upsertPending">
        <Loader2 v-if="upsertPending" class="mr-2 h-4 w-4 animate-spin" />
        {{ isEdit ? '保存' : '录入' }}
      </Button>
    </div>
  </form>
</template>
