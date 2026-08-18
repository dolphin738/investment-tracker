<script setup lang="ts">
/**
 * components/DividendForm.vue — 分红录入编辑表单（HOLD-B-P0-10 + 增量 I-02）
 *
 * 平移自 React 版 features/security-income/dividend-fee-form.tsx，schema 与
 * 错误消息逐字一致、行为契约一致。
 *
 * PRD §7.2【E】：分红 = 日期 / 标的 / 分红额（税前）/ 所得税（可选）/ 类型 / 备注。
 *
 * 分红增量口径（K-1/K-2）：
 * - amount 恒为税前；tax ≥ 0；净额 = amount − tax，实时展示且 ≥ 0（前端阻止 + 后端兜底）
 * - I-02 P0 修复：编辑分红 payload **必须携带 type**（后端全局 ValidationPipe
 *   forbidNonWhitelisted，缺 type 声明即 400「property type should not exist」）；
 *   所得税标签改「所得税（可选）」；编辑态 type 下拉可改（Q-1 建议允许）
 * - 净额由 shared computeNetAmount（整数分运算）计算，避免浮点毛刺
 *
 * D-02 / D-03：分红不进现金流、不触发重算。
 * INC-04 物理并表：费用录入已并入「录入买卖」的费用三联字段，本表单仅承载分红。
 *
 * 表单引擎由 react-hook-form + zodResolver 换为 vee-validate + zod（zodToTypedSchema
 * 桥接），校验规则与提示文案不变。
 */

import { computed, ref } from 'vue';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { Info, Loader2 } from 'lucide-vue-next';
import { isMoneyString, computeNetAmount } from '@/lib/types';
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
import SecuritySearchCombobox from '@/components/common/SecuritySearchCombobox.vue';
import { useSecurities } from '@/composables/use-securities';
import { resolveSecurity } from '@/api/security.api';
import { toast } from '@/composables/use-toast';
import { DIVIDEND_TYPE_LABEL } from '../composables/use-dividends';
import { useCreateDividend, useUpdateDividend } from '../composables/use-dividends';
import { toIsoDate } from '@/lib/constants';
import { formatCurrency } from '@/lib/utils';
import { zodToTypedSchema } from '@/lib/zod-typed-schema';
import { DividendType } from '@/api/types';
import type { DividendRecord } from '@/api/types';
import type { SecurityMaster } from '@/api/security-master.api';

/** 金额：> 0 且最多 2 位小数（PRD §8.1 NUMBER(18,2)，格式校验收敛到 shared） */
const amountSchema = z
  .string()
  .min(1, '请输入金额')
  .refine((v) => isMoneyString(v), '金额最多 2 位小数')
  .refine((v) => Number(v) > 0, '金额必须大于 0');

/** 所得税：可选、≥ 0、最多 2 位小数（K-1） */
const taxSchema = z
  .string()
  .optional()
  .refine((v) => !v || /^-?\d+(\.\d{1,2})?$/.test(v), '所得税最多 2 位小数')
  .refine((v) => !v || Number(v) >= 0, '所得税不能为负');

const recordSchema = z
  .object({
    securityId: z.string().min(1, '请选择标的'),
    date: z
      .string()
      .min(1, '请选择日期')
      .refine((v) => v <= toIsoDate(new Date()), '日期不能为未来'),
    amount: amountSchema,
    tax: taxSchema,
    // 分红类型（编辑态可改，Q-1 建议允许；录入态固定 CASH）
    type: z.nativeEnum(DividendType).optional(),
    note: z.string().max(200, '备注最多 200 字').optional(),
  })
  // 分红净额 ≥ 0（税 > 税前 → 阻止提交；后端 PATCH/POST 同口径兜底）
  .refine(
    (v) => {
      if (!v.tax) return true;
      return Number(v.amount) - Number(v.tax) >= 0;
    },
    { path: ['tax'], message: '净额不能为负' },
  );

type RecordFormValues = z.infer<typeof recordSchema>;

const props = withDefaults(
  defineProps<{
    portfolioId: string;
    /** 编辑态：分红传 DividendRecord（INC-04 后仅分红一种记录） */
    record?: DividendRecord | null;
    /** 提交成功后回调（关闭弹窗） */
    onSuccess?: () => void;
  }>(),
  {
    record: null,
    onSuccess: undefined,
  },
);

const isEdit = computed(() => Boolean(props.record));

const { data: securities, isLoading: secLoading } = useSecurities(
  computed(() => props.portfolioId),
);

/** 当前选中标的安全组合 dimension 的 securityId（表单隐藏字段，同步自 resolve） */
const securityIdRef = ref(props.record?.securityId ?? '');

const createDividend = useCreateDividend();
const updateDividend = useUpdateDividend();
const submitting = computed(
  () => createDividend.isPending.value || updateDividend.isPending.value,
);

const { handleSubmit, errors, setFieldValue, defineField } =
  useForm<RecordFormValues>({
    validationSchema: zodToTypedSchema(recordSchema),
    initialValues: {
      securityId: props.record?.securityId ?? '',
      date: props.record?.date ?? toIsoDate(new Date()),
      amount: props.record?.amount ?? '',
      tax: props.record ? (props.record.tax ?? '') : '',
      type: props.record?.type ?? DividendType.CASH,
      note: props.record?.note ?? '',
    },
  });

const [dateModel, dateAttrs] = defineField('date');
const [typeModel] = defineField('type');
const [amountModel, amountAttrs] = defineField('amount');
const [taxModel, taxAttrs] = defineField('tax');
const [noteModel, noteAttrs] = defineField('note');

/** 选中系统主数据 → resolve 懒实例化为组合标的，回填 securityId（对齐「录入买卖」§10，ADR-003） */
const queryClient = useQueryClient();
const resolveMutation = useMutation({
  mutationFn: (masterId: string) =>
    resolveSecurity(props.portfolioId, { masterId }),
  onSuccess: (res) => {
    toast.success(res.isNew ? `已创建组合标的「${res.name}」` : '标的已选中');
    securityIdRef.value = res.id;
    setFieldValue('securityId', res.id, true);
    void queryClient.invalidateQueries({
      queryKey: ['securities', 'list', props.portfolioId],
    });
  },
  onError: () => toast.error('标的解析失败，请重试'),
});

function handleSelectMaster(master: SecurityMaster): void {
  resolveMutation.mutate(master.id);
}

function handleClearSecurity(): void {
  securityIdRef.value = '';
  setFieldValue('securityId', '', true);
}

/** 当前选中标的的展示文本（编辑态回显）：列表已到且含当前标的 → 「名称（代码）」 */
const selectedSecurityLabel = computed(() => {
  if (!securityIdRef.value) return '';
  const found = securities.value?.find((s) => s.id === securityIdRef.value);
  if (found) return `${found.name}（${found.code}）`;
  return secLoading.value ? '当前标的（加载中…）' : '当前标的（已不在可选列表）';
});

/** 净额实时展示（整数分运算；输入未成型时显示占位） */
const netAmount = computed(() => {
  const amount = amountModel.value;
  const tax = taxModel.value;
  if (!amount || !isMoneyString(amount)) return null;
  if (tax && !isMoneyString(tax)) return null;
  return computeNetAmount(amount, tax || '0');
});
const netNegative = computed(
  () => netAmount.value !== null && Number(netAmount.value) < 0,
);

const onSubmit = handleSubmit((values) => {
  // I-02：payload 必须携带 type（forbidNonWhitelisted 400 根因修复）
  const payload = {
    securityId: values.securityId,
    date: values.date,
    amount: values.amount,
    // Q-1 建议允许编辑 type：编辑态取下拉值；录入态固定现金分红
    type: values.type ?? DividendType.CASH,
    tax: values.tax || undefined,
    note: values.note || undefined,
  };
  if (isEdit.value && props.record) {
    updateDividend.mutate(
      { portfolioId: props.portfolioId, id: props.record.id, payload },
      { onSuccess: () => props.onSuccess?.() },
    );
  } else {
    createDividend.mutate(
      { portfolioId: props.portfolioId, payload },
      { onSuccess: () => props.onSuccess?.() },
    );
  }
});
</script>

<template>
  <form novalidate class="space-y-4" @submit="onSubmit">
    <!-- 口径提示：不参与收益计算 -->
    <p class="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
      <Info class="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        分红为独立记录，不计入出入金现金流、不参与 XIRR 与净值计算；红利再投的现金价值已体现在持仓市值中。
      </span>
    </p>

    <!-- 标的：证券搜索选择（对齐「录入买卖」样式/逻辑，§10，不再用原生下拉） -->
    <div class="space-y-1.5">
      <Label for="income-security">标的 *</Label>
      <SecuritySearchCombobox
        id="income-security"
        :value="selectedSecurityLabel"
        :placeholder="secLoading ? '加载中…' : '搜索代码 / 名称 / 拼音首字母'"
        :disabled="secLoading && !securityIdRef"
        :on-select="handleSelectMaster"
        :on-clear="handleClearSecurity"
      />
      <p v-if="errors.securityId" class="text-xs text-destructive">
        {{ errors.securityId }}
      </p>
    </div>

    <!-- 日期 -->
    <div class="space-y-1.5">
      <Label for="income-date">日期 *</Label>
      <Input id="income-date" v-model="dateModel" v-bind="dateAttrs" type="date" />
      <p v-if="errors.date" class="text-xs text-destructive">{{ errors.date }}</p>
    </div>

    <!-- 类型（编辑态可改 type；录入态固定现金分红，I-02） -->
    <div v-if="isEdit && props.record" class="space-y-1.5">
      <Label for="income-type">类型</Label>
      <Select v-model="typeModel">
        <SelectTrigger id="income-type">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem :value="DividendType.CASH">
            {{ DIVIDEND_TYPE_LABEL[DividendType.CASH] }}
          </SelectItem>
          <SelectItem :value="DividendType.STOCK_DIVIDEND">
            {{ DIVIDEND_TYPE_LABEL[DividendType.STOCK_DIVIDEND] }}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
    <div v-else class="space-y-1.5">
      <Label>类型</Label>
      <p class="rounded-md border border-input px-3 py-2 text-sm text-muted-foreground">
        现金分红（红利再投不录入）
      </p>
    </div>

    <!-- 金额（分红 = 税前） -->
    <div class="space-y-1.5">
      <Label for="income-amount">分红额（税前）*</Label>
      <Input
        id="income-amount"
        v-model="amountModel"
        v-bind="amountAttrs"
        type="text"
        inputmode="decimal"
        placeholder="0.00"
      />
      <p v-if="errors.amount" class="text-xs text-destructive">{{ errors.amount }}</p>
    </div>

    <!-- 所得税（I-02：标签改「（可选）」） -->
    <div class="space-y-1.5">
      <Label for="income-tax">所得税（可选）</Label>
      <Input
        id="income-tax"
        v-model="taxModel"
        v-bind="taxAttrs"
        type="text"
        inputmode="decimal"
        placeholder="0.00"
      />
      <p v-if="errors.tax" class="text-xs text-destructive">{{ errors.tax }}</p>
    </div>

    <!-- 净额实时展示 -->
    <div class="space-y-1.5">
      <Label>净额（自动）</Label>
      <div
        :class="[
          'rounded-md border px-3 py-2 text-sm tabular-nums',
          netNegative
            ? 'border-destructive/60 bg-destructive/5 text-destructive'
            : 'bg-muted/40 text-foreground',
        ]"
        data-testid="dividend-net-amount"
      >
        <template v-if="netAmount !== null">
          {{ formatCurrency(Number(netAmount), 2) }}
        </template>
        <span v-else class="text-muted-foreground">
          填写分红额与所得税后自动计算
        </span>
      </div>
    </div>

    <!-- 备注 -->
    <div class="space-y-1.5">
      <Label for="income-note">备注</Label>
      <Textarea id="income-note" v-model="noteModel" v-bind="noteAttrs" rows="2" />
      <p v-if="errors.note" class="text-xs text-destructive">{{ errors.note }}</p>
    </div>

    <div class="flex justify-end gap-2 pt-2">
      <Button type="submit" :disabled="submitting">
        <Loader2 v-if="submitting" class="mr-2 h-4 w-4 animate-spin" />
        保存
      </Button>
    </div>
  </form>
</template>