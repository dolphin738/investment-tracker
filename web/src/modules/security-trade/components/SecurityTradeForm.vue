<script setup lang="ts">
/**
 * modules/security-trade/components/SecurityTradeForm.vue — 证券买卖录入/编辑弹窗表单
 *
 * 平移自 React 版 features/security-trade/security-trade-form.tsx,
 * schema 与错误消息逐字一致,录入 / 编辑共用同一 schema + 同一布局。
 *
 * - 统一字段与顺序:方向 → 日期 → 标的 → 资产类型 → 数量 → 成交额 → 费用三框
 *   (佣金/印花税/其他)→ 成本价(含费单价,只读预览)→ 备注
 * - 统一公式(K-3,买入/卖出同式):
 *   - 买入:costPrice = (成交额 + 费用合计) / 数量
 *   - 卖出:costPrice = (成交额 − 费用合计) / 数量;费用合计 > 成交额 → 阻止(C-7 前端闸)
 * - 编辑态回填:费用三框直接取自 trade.commission/stampTax/other;成交额按口径回填
 *   q × costPrice −/+ feeTotal(含费单价金融算法不变)。
 *
 * 表单引擎由 react-hook-form + zodResolver 换为 vee-validate + zod
 * (桥接函数见 lib/zod-typed-schema),校验规则与提示文案不变。
 *
 * INC-04 物理并表:费用明细直接承载于 security_trades 一行,feeTotal = 三列之和。
 */

import { computed, ref, watch } from 'vue';
import { useForm } from 'vee-validate';
import { useMutation } from '@tanstack/vue-query';
import { z } from 'zod';
import { Loader2 } from 'lucide-vue-next';
import { toast } from '@/composables/use-toast';
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
import {
  useCreateSecurityTrade,
  useUpdateSecurityTrade,
} from '../composables/use-security-trades';
import { useSecurities } from '@/composables/use-securities';
import { resolveSecurity, updateSecurity } from '@/api/security.api';
import { toIsoDate } from '@/lib/constants';
import { SecuritySide, SecurityType, sumMoney } from '@/lib/types';
import { formatCurrency } from '@/lib/utils';
import { zodToTypedSchema } from '@/lib/zod-typed-schema';
import type {
  CreateSecurityTradeRequest,
  SecurityTradeResponse,
  UpdateSecurityDto,
} from '@/api/types';

/** 资产类型选项(供手动修改使用),与 React 版逐字一致 */
const SECURITY_TYPE_OPTIONS: ReadonlyArray<{ value: SecurityType; label: string }> = [
  { value: SecurityType.STOCK, label: '股票' },
  { value: SecurityType.ON_EXCHANGE_FUND, label: '场内基金' },
  { value: SecurityType.OFF_EXCHANGE_FUND, label: '场外基金' },
  { value: SecurityType.BOND, label: '债券' },
  { value: SecurityType.CONVERTIBLE_BOND, label: '可转债' },
  { value: SecurityType.INDEX, label: '指数' },
  { value: SecurityType.HK_STOCK, label: '港股' },
  { value: SecurityType.OTHER, label: '其他' },
];

/** 费用字段:可选、非负、最多 2 位小数 */
const feeFieldSchema = z
  .string()
  .optional()
  .refine((v) => !v || /^\d+(\.\d{1,2})?$/.test(v), '费用最多 2 位小数')
  .refine((v) => !v || Number(v) >= 0, '费用不能为负');

/** 公共字段:方向 / 日期 / 标的 / 数量 / 备注 */
const baseFields = {
  date: z
    .string()
    .min(1, '请选择日期')
    .refine((v) => v <= toIsoDate(new Date()), '日期不能为未来'),
  side: z.nativeEnum(SecuritySide),
  securityId: z.string().min(1, '请选择标的'),
  // Vue 对 type=number 输入的 v-model 会自动把值转为数字,
  // 此处先归一为字符串,保持与 React 版 z.string() 同口径(错误消息不变)
  quantity: z.preprocess(
    (v) => (typeof v === 'number' ? String(v) : v),
    z
      .string()
      .min(1, '请输入数量')
      .refine((v) => Number(v) > 0, '数量必须大于 0'),
  ),
  note: z.string().max(200, '备注最多 200 字').optional(),
};

/**
 * 单一 schema(录入 / 编辑共用)。
 *
 * 成交额允许最多 6 位小数:录入态用户通常输入 2 位金额;编辑态回填 q × costPrice −/+ feeTotal
 * 可能产生 3~6 位小数(costPrice 为 6 位小数),若截断到 2 位会破坏「不改动即成本守恒」。
 */
const tradeSchema = z
  .object({
    ...baseFields,
    tradeAmount: z
      .string()
      .min(1, '请输入成交额')
      .refine((v) => /^\d+(\.\d{1,6})?$/.test(v), '成交额最多 6 位小数')
      .refine((v) => Number(v) > 0, '成交额必须大于 0'),
    commission: feeFieldSchema,
    stampTax: feeFieldSchema,
    other: feeFieldSchema,
  })
  // 卖出费用合计 > 成交额 → 阻止(C-7 前端闸 + 后端 costPrice>0 DTO 兜底)
  .superRefine((data, ctx) => {
    if (data.side !== SecuritySide.SELL_SEC) return;
    const feeTotal = sumMoney([
      data.commission || '0',
      data.stampTax || '0',
      data.other || '0',
    ]);
    if (Number(feeTotal) > Number(data.tradeAmount || '0')) {
      ctx.addIssue({
        code: 'custom',
        path: ['tradeAmount'],
        message: '费用合计不能超过成交额',
      });
    }
  });

type TradeFormValues = z.infer<typeof tradeSchema>;

const props = defineProps<{
  portfolioId: string;
  /** 传入则编辑,否则新建 */
  trade?: SecurityTradeResponse | null;
}>();

/** 提交成功后回调(关闭弹窗) */
const emit = defineEmits<{ success: [] }>();

/** 6 位小数字符串(编辑态成交额回填用;去除尾随零避免输入框显示 123.450000) */
function toPrecision6(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  return String(Math.round(n * 1e6) / 1e6);
}

const isEdit = computed(() => Boolean(props.trade));
const createMutation = useCreateSecurityTrade();
const updateMutation = useUpdateSecurityTrade();

/** 手动修改资产类型(PATCH /securities/:id)- mutation 布尔态供禁用判断 */
const updateSecurityMutation = useMutation({
  mutationFn: ({
    securityId,
    payload,
  }: {
    securityId: string;
    payload: UpdateSecurityDto;
  }) => updateSecurity(props.portfolioId, securityId, payload),
});
const updateSecurityPending = computed(() => updateSecurityMutation.isPending.value);

const { data: securities, isLoading: secLoading } = useSecurities(props.portfolioId);
const today = toIsoDate(new Date());
const submitting = ref(false);
const currentSecurityType = ref<SecurityType | null>(null);
/**
 * 当前选中标的的展示元数据（编辑错位标的修复）：resolve 成功后缓存选中主数据的
 * name/code/type，使「当前标的不在组合证券字典内」时也能正确回显名称与资产类型，
 * 不再停滞在「加载中 / 已不在可选列表」。
 */
const resolvedSecurity = ref<{
  id: string;
  name: string;
  code: string;
  type: SecurityType;
} | null>(null);

const {
  handleSubmit,
  resetForm,
  errors,
  defineField,
} = useForm<TradeFormValues>({
  validationSchema: zodToTypedSchema(tradeSchema),
  initialValues: {
    date: today,
    // 编辑态首帧即按 trade.side 回填(避免方向栏空白「选择方向」);新建默认买入
    side: props.trade?.side ?? SecuritySide.BUY_SEC,
    securityId: '',
    quantity: '',
    tradeAmount: '',
    commission: '',
    stampTax: '',
    other: '',
    note: '',
  },
});

const [dateModel, dateAttrs] = defineField('date');
const [sideModel] = defineField('side');
const [securityIdModel] = defineField('securityId');
const [quantityModel, quantityAttrs] = defineField('quantity');
const [tradeAmountModel, tradeAmountAttrs] = defineField('tradeAmount');
const [commissionModel, commissionAttrs] = defineField('commission');
const [stampTaxModel, stampTaxAttrs] = defineField('stampTax');
const [otherModel, otherAttrs] = defineField('other');
const [noteModel, noteAttrs] = defineField('note');

/**
 * 编辑态回填(I-01 验收 3/4):
 * - 费用三框直接取自 trade.commission/stampTax/other(INC-04 物理并表,无独立费用表)
 * - 成交额:新口径(含费单价口径) q × costPrice −/+ feeTotal
 */
watch(
  () => props.trade,
  (trade) => {
    // 切换记录时清掉手动覆盖的类型与缓存元数据,交由下方推导 watch 重新带出
    currentSecurityType.value = null;
    resolvedSecurity.value = null;
    if (trade) {
      const feeTotal = Number(trade.feeTotal);
      const baseAmount = Number(trade.quantity) * Number(trade.costPrice);
      const tradeAmount =
        trade.side === SecuritySide.BUY_SEC
          ? baseAmount - feeTotal
          : baseAmount + feeTotal;
      resetForm({
        values: {
          date: trade.date,
          side: trade.side,
          securityId: trade.securityId,
          quantity: trade.quantity,
          tradeAmount: toPrecision6(tradeAmount),
          commission: trade.commission || '',
          stampTax: trade.stampTax || '',
          other: trade.other || '',
          note: trade.note ?? '',
        },
      });
    } else {
      resetForm({
        values: {
          date: today,
          side: SecuritySide.BUY_SEC,
          securityId: '',
          quantity: '',
          tradeAmount: '',
          commission: '',
          stampTax: '',
          other: '',
          note: '',
        },
      });
    }
  },
  { immediate: true },
);

/**
 * 标的下拉的受控值(INC-02):恒含 trade.securityId,保证编辑态任何时刻 value 都能命中选项
 * (securities 异步未到时表单 securityId 已写入,但下拉暂无对应项)。
 */
const selectedSecurityId = computed(
  () => (securityIdModel.value as string) || props.trade?.securityId || '',
);

/**
 * 资产类型首帧推导:编辑态 / 异步加载完成后,从标的列表推导当前资产类型;
 * 仅在尚未被手动覆盖(currentSecurityType 为 null)时推导。
 * 组合字典未命中时回退到 resolve 缓存元数据(resolvedSecurity),避免「加载中」停滞。
 */
watch(
  [securities, selectedSecurityId, currentSecurityType, resolvedSecurity],
  () => {
    if (currentSecurityType.value || !selectedSecurityId.value) return;
    const found = (securities.value ?? []).find(
      (s) => s.id === selectedSecurityId.value,
    );
    if (found?.type) {
      currentSecurityType.value = found.type as SecurityType;
      return;
    }
    if (resolvedSecurity.value?.id === selectedSecurityId.value) {
      currentSecurityType.value = resolvedSecurity.value.type;
    }
  },
);

/**
 * 当前选中标的的展示文本(编辑态回显,INC-02 保底语义):
 * - 列表已到且含当前标的 → 名称(代码)
 * - resolve 缓存的选中元数据命中 → 名称(代码)（标的不在组合字典也能正常显示）
 * - 列表未到 → 当前标的(加载中…)
 * - 列表已到但当前标的不在 → 当前标的(已不在可选列表)
 */
const selectedSecurityLabel = computed(() => {
  if (!selectedSecurityId.value) return '';
  const found = (securities.value ?? []).find(
    (s) => s.id === selectedSecurityId.value,
  );
  if (found) return `${found.name}（${found.code}）`;
  if (resolvedSecurity.value?.id === selectedSecurityId.value) {
    return `${resolvedSecurity.value.name}（${resolvedSecurity.value.code}）`;
  }
  return secLoading.value ? '当前标的（加载中…）' : '当前标的（已不在可选列表）';
});

/** 选中系统主数据 → resolve 懒实例化为组合标的,回填 securityId(ADR-003) */
const resolveSecurityMutation = useMutation({
  mutationFn: (masterId: string) =>
    resolveSecurity(props.portfolioId, { masterId }),
  onSuccess: (res) => {
    securityIdModel.value = res.id;
    // 记录当前证券的类型(后端由代码前缀推断)与展示元数据,供手动修改/错位标回显使用
    currentSecurityType.value = res.type as SecurityType;
    resolvedSecurity.value = {
      id: res.id,
      name: res.name,
      code: res.code,
      type: res.type as SecurityType,
    };
  },
});

function handleSelectMaster(master: { id: string }): void {
  resolveSecurityMutation.mutate(master.id);
}

function handleClear(): void {
  securityIdModel.value = '';
  currentSecurityType.value = null;
  resolvedSecurity.value = null;
}

/** 手动修改资产类型 */
function handleSecurityTypeChange(newType: SecurityType): void {
  if (
    !selectedSecurityId.value ||
    !currentSecurityType.value ||
    newType === currentSecurityType.value
  ) {
    return;
  }
  updateSecurityMutation.mutate(
    {
      securityId: selectedSecurityId.value,
      payload: { type: newType },
    },
    {
      onSuccess: () => {
        currentSecurityType.value = newType;
        toast.success('资产类型已更新');
      },
    },
  );
}

/** 费用合计(两态统一;输入未成型时 null) */
const feeTotal = computed(() => {
  const inputs: Array<string | number | undefined> = [
    commissionModel.value,
    stampTaxModel.value,
    otherModel.value,
  ];
  if (
    inputs.some(
      (v) =>
        v != null && String(v) !== '' && !/^\d+(\.\d{1,2})?$/.test(String(v)),
    )
  ) {
    return null;
  }
  return sumMoney(inputs.map((v) => String(v ?? '').trim() || '0'));
});

const sideValue = computed(() => sideModel.value as SecuritySide);

/** 成本价(含费单价,只读实时预览,两态一致,K-3):买入=(成交额+合计)/数量;卖出=(成交额−合计)/数量 */
const derivedPrice = computed(() => {
  if (feeTotal.value === null) return null;
  const qty = Number(quantityModel.value);
  const amount = Number(tradeAmountModel.value);
  if (!quantityModel.value || !tradeAmountModel.value || Number.isNaN(qty) || Number.isNaN(amount)) {
    return null;
  }
  if (qty <= 0 || amount <= 0) return null;
  const raw =
    (sideValue.value === SecuritySide.BUY_SEC
      ? amount + Number(feeTotal.value)
      : amount - Number(feeTotal.value)) / qty;
  if (raw <= 0) return null;
  // K-3/U-3:单价收敛到 6 位小数后按现有 number 契约提交
  return Number(raw.toFixed(6));
});

/** 新建成功后的表单重置值(录入 / 编辑共用) */
const resetDefaults = {
  date: today,
  side: SecuritySide.BUY_SEC,
  securityId: '',
  quantity: '',
  tradeAmount: '',
  commission: '',
  stampTax: '',
  other: '',
  note: '',
};

/**
 * 统一保存流程(I-01 验收 6,两态对称):提交单笔 /security-trades,
 * INC-04 物理并表承载 { date, side, securityId, quantity, costPrice(含费单价),
 * commission, stampTax, other, feeTotal }。
 */
const onSubmit = handleSubmit((values) => {
  submitting.value = true;
  const feeTotalStr = sumMoney([
    values.commission || '0',
    values.stampTax || '0',
    values.other || '0',
  ]);
  const qty = Number(values.quantity);
  const amount = Number(values.tradeAmount);
  const raw =
    (values.side === SecuritySide.BUY_SEC
      ? amount + Number(feeTotalStr)
      : amount - Number(feeTotalStr)) / qty;
  const costPrice = Number(raw.toFixed(6));

  const payload: CreateSecurityTradeRequest = {
    securityId: values.securityId,
    date: values.date,
    side: values.side,
    quantity: qty,
    costPrice,
    commission: Number(values.commission || '0'),
    stampTax: Number(values.stampTax || '0'),
    other: Number(values.other || '0'),
    feeTotal: Number(feeTotalStr),
    note: values.note || undefined,
  };

  const handleSettled = (): void => {
    submitting.value = false;
  };
  const handleError = (): void => {
    toast.error('保存失败，请稍后重试');
  };
  const handleSuccess = (): void => {
    resetForm({ values: resetDefaults });
    emit('success');
  };

  if (isEdit.value && props.trade) {
    updateMutation.mutate(
      { portfolioId: props.portfolioId, id: props.trade.id, payload },
      {
        onSettled: handleSettled,
        onError: handleError,
        onSuccess: handleSuccess,
      },
    );
  } else {
    createMutation.mutate(
      { portfolioId: props.portfolioId, payload },
      {
        onSettled: handleSettled,
        onError: handleError,
        onSuccess: handleSuccess,
      },
    );
  }
});
</script>

<template>
  <form @submit="onSubmit">
    <div class="space-y-4">
      <!-- 方向 -->
      <div class="space-y-2">
        <Label for="st-side">方向 *</Label>
        <Select v-model="sideModel">
          <SelectTrigger id="st-side">
            <SelectValue placeholder="选择方向" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="SecuritySide.BUY_SEC">买入</SelectItem>
            <SelectItem :value="SecuritySide.SELL_SEC">卖出</SelectItem>
          </SelectContent>
        </Select>
        <p v-if="errors.side" class="text-xs text-destructive">{{ errors.side }}</p>
      </div>

      <!-- 日期 -->
      <div class="space-y-2">
        <Label for="st-date">日期 *</Label>
        <Input
          id="st-date"
          v-model="dateModel"
          v-bind="dateAttrs"
          type="date"
          :max="today"
        />
        <p v-if="errors.date" class="text-xs text-destructive">{{ errors.date }}</p>
      </div>

      <!-- 标的:证券搜索选择(不再支持「新建标的」) -->
      <div class="space-y-2">
        <Label for="st-security">标的 *</Label>
        <SecuritySearchCombobox
          id="st-security"
          :value="selectedSecurityLabel"
          :placeholder="secLoading ? '加载中…' : '搜索代码 / 名称 / 拼音首字母'"
          :disabled="secLoading && !selectedSecurityId"
          @select="handleSelectMaster"
          @clear="handleClear"
        />
        <p v-if="errors.securityId" class="text-xs text-destructive">
          {{ errors.securityId }}
        </p>
      </div>

      <!-- 资产类型:选中证券后自动带出,可手动修改 -->
      <div class="space-y-2">
        <Label for="st-security-type">资产类型（可修改）</Label>
        <Select
          :model-value="currentSecurityType ?? undefined"
          @update:model-value="(v: string) => handleSecurityTypeChange(v as SecurityType)"
          :disabled="!selectedSecurityId || updateSecurityPending"
        >
          <SelectTrigger id="st-security-type">
            <SelectValue
              :placeholder="
                selectedSecurityId
                  ? secLoading
                    ? '加载中…'
                    : '无法推断类型'
                  : '请先选择标的'
              "
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              v-for="opt in SECURITY_TYPE_OPTIONS"
              :key="opt.value"
              :value="opt.value"
            >
              {{ opt.label }}
            </SelectItem>
          </SelectContent>
        </Select>
        <p v-if="updateSecurityPending" class="text-xs text-muted-foreground">
          更新中...
        </p>
      </div>

      <!-- 数量 -->
      <div class="space-y-2">
        <Label for="st-quantity">数量 *</Label>
        <Input
          id="st-quantity"
          v-model="quantityModel"
          v-bind="quantityAttrs"
          type="number"
          step="0.000001"
          min="0"
          placeholder="0"
        />
        <p v-if="errors.quantity" class="text-xs text-destructive">
          {{ errors.quantity }}
        </p>
      </div>

      <!-- 成交额(两态统一输入) -->
      <div class="space-y-2">
        <Label for="st-trade-amount">成交额（元）*</Label>
        <Input
          id="st-trade-amount"
          v-model="tradeAmountModel"
          v-bind="tradeAmountAttrs"
          type="text"
          inputmode="decimal"
          placeholder="0.00"
        />
        <p v-if="errors.tradeAmount" class="text-xs text-destructive">
          {{ errors.tradeAmount }}
        </p>
      </div>

      <!-- 费用三框并列(两态统一) -->
      <div class="space-y-2">
        <Label>费用（元）</Label>
        <div class="grid grid-cols-3 gap-2">
          <div class="space-y-1">
            <Label for="st-commission" class="text-xs">佣金</Label>
            <Input
              id="st-commission"
              v-model="commissionModel"
              v-bind="commissionAttrs"
              type="text"
              inputmode="decimal"
              placeholder="0.00"
            />
            <p v-if="errors.commission" class="text-xs text-destructive">
              {{ errors.commission }}
            </p>
          </div>
          <div class="space-y-1">
            <Label for="st-stamp-tax" class="text-xs">印花税</Label>
            <Input
              id="st-stamp-tax"
              v-model="stampTaxModel"
              v-bind="stampTaxAttrs"
              type="text"
              inputmode="decimal"
              placeholder="0.00"
            />
            <p v-if="errors.stampTax" class="text-xs text-destructive">
              {{ errors.stampTax }}
            </p>
          </div>
          <div class="space-y-1">
            <Label for="st-other" class="text-xs">其他</Label>
            <Input
              id="st-other"
              v-model="otherModel"
              v-bind="otherAttrs"
              type="text"
              inputmode="decimal"
              placeholder="0.00"
            />
            <p v-if="errors.other" class="text-xs text-destructive">
              {{ errors.other }}
            </p>
          </div>
        </div>
        <p
          class="rounded-md border bg-muted/40 px-3 py-2 text-sm tabular-nums"
          data-testid="fee-total"
        >
          费用合计（自动）=
          {{ feeTotal !== null ? formatCurrency(Number(feeTotal)) : '¥0.00' }}
        </p>
      </div>

      <!-- 成本价实时展示(K-3,两态统一只读预览) -->
      <div class="space-y-2">
        <Label>成本价（自动，含费）</Label>
        <div class="rounded-md border bg-muted/40 px-3 py-2 text-sm tabular-nums">
          <template v-if="derivedPrice !== null">
            {{ formatCurrency(derivedPrice, 6) }}
            <span class="ml-2 text-xs text-muted-foreground">
              = (成交额{{ sideValue === SecuritySide.BUY_SEC ? '+' : '−' }}费用合计)/数量
            </span>
          </template>
          <span v-else class="text-muted-foreground">
            填写数量、成交额与费用后自动计算
          </span>
        </div>
      </div>

      <!-- 备注 -->
      <div class="space-y-2">
        <Label for="st-note">备注（可选）</Label>
        <Textarea
          id="st-note"
          v-model="noteModel"
          v-bind="noteAttrs"
          placeholder="如：建仓 / 加仓 / 止盈"
          rows="2"
        />
        <p v-if="errors.note" class="text-xs text-destructive">{{ errors.note }}</p>
      </div>

      <!-- 提示 -->
      <p class="flex items-start gap-1.5 text-xs text-muted-foreground">
        组合内部买卖，不计入出入金现金流；持仓由买卖流水实时推导。佣金 / 印花税 /
        其他费用已并入含费成本价（INC-04 物理并表至证券买卖流水）。
      </p>
    </div>

    <div class="mt-6 flex justify-end gap-2">
      <Button type="submit" :disabled="submitting">
        <Loader2 v-if="submitting" class="mr-2 h-4 w-4 animate-spin" />
        {{ isEdit ? '保存' : '录入' }}
      </Button>
    </div>
  </form>
</template>