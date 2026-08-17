<script setup lang="ts">
/**
 * modules/cashflow/components/CashflowForm.vue — 出入金录入/编辑弹窗表单
 *
 * 平移自 React 版 features/cashflow/cashflow-form.tsx，schema 与错误消息逐字一致。
 *
 * PRD §7.1：录入/编辑弹窗仅含 类型(存入/取出) / 日期 / 金额 / 备注，
 * 不含证券明细字段 —— 出入金与证券买卖是两回事（C-10）。
 *
 * 表单引擎由 react-hook-form + zodResolver 换为 vee-validate + zod
 * （桥接函数见 lib/zod-typed-schema），校验规则与提示文案不变。
 */

import { ref, watch } from 'vue';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { Loader2 } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useCreateTransaction,
  useUpdateTransaction,
} from '../composables/use-transactions';
import { toIsoDate } from '@/lib/constants';
import { CashFlowType } from '@/lib/types';
import { zodToTypedSchema } from '@/lib/zod-typed-schema';
import type { TransactionResponse } from '@/api/types';

const cashflowSchema = z.object({
  date: z
    .string()
    .min(1, '请选择日期')
    .refine((v) => v <= toIsoDate(new Date()), '日期不能为未来'),
  type: z.nativeEnum(CashFlowType),
  amount: z.preprocess(
    // Vue 对 type=number 输入的 v-model 会自动把值转为数字，
    // 此处先归一为字符串，保持与 React 版 z.string() 同口径（错误消息不变）
    (v) => (typeof v === 'number' ? String(v) : v),
    z
      .string()
      .min(1, '请输入金额')
      .refine((v) => Number(v) > 0, '金额必须大于 0'),
  ),
  note: z.string().max(200, '备注最多 200 字').optional(),
});

type CashflowFormValues = z.infer<typeof cashflowSchema>;

const props = defineProps<{
  portfolioId: string;
  /** 传入则编辑，否则新建 */
  cashflow?: TransactionResponse | null;
  /**
   * 提交成功后回调（携带 mutation 响应，供页面读取重算结果/关闭弹窗）。
   * 重算 toast 与 FLOW-P0-06 软提示由 use-transactions 的 mutation onSuccess 统一触发，
   * 此处仅透传响应，不重复弹 toast。
   */
  onSuccess?: (result?: TransactionResponse) => void;
}>();

const isEdit = Boolean(props.cashflow);
const createMutation = useCreateTransaction();
const updateMutation = useUpdateTransaction();
const today = toIsoDate(new Date());
const submitting = ref(false);

const { handleSubmit, resetForm, errors, defineField } = useForm<CashflowFormValues>({
  validationSchema: zodToTypedSchema(cashflowSchema),
  initialValues: {
    date: today,
    // 编辑态首帧即按 cashflow.type 回填（避免类型栏空白「选择类型」）；新建默认存入
    type: props.cashflow?.type ?? CashFlowType.BUY,
    amount: '',
    note: '',
  },
});

const [dateModel, dateAttrs] = defineField('date');
const [typeModel] = defineField('type');
const [amountModel, amountAttrs] = defineField('amount');
const [noteModel, noteAttrs] = defineField('note');

// cashflow 切换（新增 <-> 编辑）时回填表单
watch(
  () => props.cashflow,
  (cashflow) => {
    if (cashflow) {
      resetForm({
        values: {
          date: cashflow.date,
          type: cashflow.type,
          amount: cashflow.amount,
          note: cashflow.note ?? '',
        },
      });
    } else {
      resetForm({ values: { date: today, type: CashFlowType.BUY, amount: '', note: '' } });
    }
  },
  { immediate: true },
);

const onSubmit = handleSubmit((values) => {
  submitting.value = true;
  const payload = {
    date: values.date,
    type: values.type,
    amount: values.amount,
    note: values.note || undefined,
  };
  if (isEdit && props.cashflow) {
    updateMutation.mutate(
      { portfolioId: props.portfolioId, id: props.cashflow.id, payload },
      {
        onSettled: () => {
          submitting.value = false;
        },
        onSuccess: (data) => props.onSuccess?.(data),
      },
    );
  } else {
    createMutation.mutate(
      { portfolioId: props.portfolioId, payload },
      {
        onSettled: () => {
          submitting.value = false;
        },
        onSuccess: (data) => {
          // 新建成功：重置表单继续录下一笔（弹窗由父级决定是否关闭）
          resetForm({ values: { date: today, type: CashFlowType.BUY, amount: '', note: '' } });
          props.onSuccess?.(data);
        },
      },
    );
  }
});
</script>

<template>
  <form @submit="onSubmit">
    <div class="space-y-4">
      <!-- 类型 -->
      <div class="space-y-2">
        <Label for="cf-type">类型</Label>
        <Select v-model="typeModel">
          <SelectTrigger id="cf-type">
            <SelectValue placeholder="选择类型" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="CashFlowType.BUY">存入</SelectItem>
            <SelectItem :value="CashFlowType.SELL">取出</SelectItem>
          </SelectContent>
        </Select>
        <p v-if="errors.type" class="text-xs text-destructive">{{ errors.type }}</p>
      </div>

      <!-- 日期 -->
      <div class="space-y-2">
        <Label for="cf-date">日期</Label>
        <Input
          id="cf-date"
          v-model="dateModel"
          v-bind="dateAttrs"
          type="date"
          :max="today"
        />
        <p v-if="errors.date" class="text-xs text-destructive">{{ errors.date }}</p>
      </div>

      <!-- 金额 -->
      <div class="space-y-2">
        <Label for="cf-amount">金额（元）</Label>
        <Input
          id="cf-amount"
          v-model="amountModel"
          v-bind="amountAttrs"
          type="number"
          step="0.01"
          min="0.01"
          placeholder="0.00"
        />
        <p v-if="errors.amount" class="text-xs text-destructive">{{ errors.amount }}</p>
      </div>

      <!-- 备注 -->
      <div class="space-y-2">
        <Label for="cf-note">备注（可选）</Label>
        <Textarea
          id="cf-note"
          v-model="noteModel"
          v-bind="noteAttrs"
          placeholder="如：工资入金 / 生活支出"
          rows="2"
        />
        <p v-if="errors.note" class="text-xs text-destructive">{{ errors.note }}</p>
      </div>
    </div>

    <div class="mt-6 flex justify-end gap-2">
      <Button type="submit" :disabled="submitting">
        <Loader2 v-if="submitting" class="mr-2 h-4 w-4 animate-spin" />
        {{ isEdit ? '保存' : '录入' }}
      </Button>
    </div>
  </form>
</template>
