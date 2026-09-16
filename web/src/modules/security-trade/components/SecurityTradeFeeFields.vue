<script setup lang="ts">
/**
 * modules/security-trade/components/SecurityTradeFeeFields.vue — 证券买卖表单尾部区块（纯展示子组件）
 *
 * 自 SecurityTradeForm.vue 模板原样平移（根级顺序与拆分前逐字一致）：
 * 费用三框并列（佣金/印花税/其他）、费用合计（自动）展示、成本价（含费，只读实时预览，K-3）
 * 展示、备注输入与页尾提示文案。
 * 展示用计算 feeTotal / derivedPrice / sideValue 随块平移至此，公式逐字不变。
 *
 * 数据 hook 全部留在门面：本组件经 props 接收字段模型与 attrs、数量/成交额/方向
 * （仅作成本价公式输入），通过 update:* 事件回写；
 * 严禁在此新建任何 useQuery / useMutation / useForm。
 *
 * 多根 fragment 渲染：根级字段块作为门面 `<div class="space-y-4">` 的直接子节点，
 * 保持与拆分前逐字节一致的间距语义（space-y 相邻兄弟选择器）。
 */
import { computed } from 'vue';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatCurrency } from '@/lib/utils';
import { SecuritySide, sumMoney } from '@/lib/types';
import type { TradeFormValues } from './security-trade-schema';

const props = defineProps<{
  /** vee-validate 费用字段模型（门面 defineField 的当前值；回写走对应 update:* 事件） */
  commissionModel: string | undefined;
  commissionAttrs: Record<string, unknown>;
  stampTaxModel: string | undefined;
  stampTaxAttrs: Record<string, unknown>;
  otherModel: string | undefined;
  otherAttrs: Record<string, unknown>;
  /** 备注字段（schema 可选字段,defineField 模型为 string | undefined） */
  noteModel: string | undefined;
  noteAttrs: Record<string, unknown>;
  /** 成本价公式输入（只读）：数量 / 成交额 / 方向 */
  quantityModel: string | number;
  tradeAmountModel: string;
  sideModel: SecuritySide;
  /** vee-validate errors（门面下传的当前校验错误快照） */
  errors: Partial<Record<keyof TradeFormValues, string | undefined>>;
}>();

const emit = defineEmits<{
  'update:commissionModel': [value: string | undefined];
  'update:stampTaxModel': [value: string | undefined];
  'update:otherModel': [value: string | undefined];
  'update:noteModel': [value: string | undefined];
}>();

/** 字段模型代理：props 只读，写操作经事件回传门面（vee-validate v-model 语义不变） */
const commissionProxy = computed({
  get: () => props.commissionModel,
  set: (value: string | undefined) => emit('update:commissionModel', value),
});
const stampTaxProxy = computed({
  get: () => props.stampTaxModel,
  set: (value: string | undefined) => emit('update:stampTaxModel', value),
});
const otherProxy = computed({
  get: () => props.otherModel,
  set: (value: string | undefined) => emit('update:otherModel', value),
});
const noteProxy = computed({
  get: () => props.noteModel,
  set: (value: string | undefined) => emit('update:noteModel', value),
});

const sideValue = computed(() => props.sideModel as SecuritySide);

/** 费用合计(两态统一;输入未成型时 null) */
const feeTotal = computed(() => {
  const inputs: Array<string | number | undefined> = [
    props.commissionModel,
    props.stampTaxModel,
    props.otherModel,
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

/** 成本价(含费单价,只读实时预览,两态一致,K-3):买入=(成交额+合计)/数量;卖出=(成交额−合计)/数量 */
const derivedPrice = computed(() => {
  if (feeTotal.value === null) return null;
  const qty = Number(props.quantityModel);
  const amount = Number(props.tradeAmountModel);
  if (
    !props.quantityModel ||
    !props.tradeAmountModel ||
    Number.isNaN(qty) ||
    Number.isNaN(amount)
  ) {
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
</script>

<template>
  <!-- 费用三框并列(两态统一) -->
  <div class="space-y-2">
    <Label>费用（元）</Label>
    <div class="grid grid-cols-3 gap-2">
      <div class="space-y-1">
        <Label for="st-commission" class="text-xs">佣金</Label>
        <Input
          id="st-commission"
          v-model="commissionProxy"
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
          v-model="stampTaxProxy"
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
          v-model="otherProxy"
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
      v-model="noteProxy"
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
</template>
