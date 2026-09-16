<script setup lang="ts">
/**
 * modules/security-trade/components/SecurityTradeCoreFields.vue — 证券买卖表单基础字段组（纯展示子组件）
 *
 * 自 SecurityTradeForm.vue 模板原样平移：方向 / 日期 / 标的 / 资产类型 / 数量 / 成交额
 * 六个字段块，以及标的回显文案 selectedSecurityLabel 的推导。
 *
 * 数据 hook 全部留在门面：本组件经 props 接收 vee-validate 字段模型与 attrs、门面状态，
 * 通过 update:* / selectMaster / clear / securityTypeChange 事件回写；
 * 严禁在此新建任何 useQuery / useMutation / useForm。
 *
 * 多根 fragment 渲染：根级字段块作为门面 `<div class="space-y-4">` 的直接子节点，
 * 保持与拆分前逐字节一致的间距语义（space-y 相邻兄弟选择器）。
 */
import { computed } from 'vue';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import SecuritySearchCombobox from '@/components/common/SecuritySearchCombobox.vue';
import { SECURITY_TYPE_OPTIONS } from './security-trade-schema';
import type { TradeFormValues } from './security-trade-schema';
import { SecuritySide, type SecurityType } from '@/lib/types';

const props = defineProps<{
  /** vee-validate 字段模型（门面 defineField 的当前值；回写走对应 update:* 事件） */
  sideModel: SecuritySide;
  dateModel: string;
  dateAttrs: Record<string, unknown>;
  quantityModel: string | number;
  quantityAttrs: Record<string, unknown>;
  tradeAmountModel: string;
  tradeAmountAttrs: Record<string, unknown>;
  /** vee-validate errors（门面下传的当前校验错误快照） */
  errors: Partial<Record<keyof TradeFormValues, string | undefined>>;
  /** 日期上限（门面 today，与 schema「日期不能为未来」同口径） */
  maxDate: string;
  /** 标的回显所需门面状态（useSecurities 数据与加载态、resolve 缓存、受控选中 id） */
  securities:
    | Array<{ id: string; name: string; code: string; type?: string }>
    | undefined;
  secLoading: boolean;
  secDetailLoading: boolean;
  selectedSecurityId: string;
  resolvedSecurity: {
    id: string;
    name: string;
    code: string;
    type: SecurityType;
  } | null;
  /** 当前资产类型（门面推导 / resolve 缓存，可手动修改） */
  currentSecurityType: SecurityType | null;
  /** PATCH 资产类型 mutation 进行中（禁用下拉 + 「更新中...」提示） */
  updateSecurityPending: boolean;
}>();

const emit = defineEmits<{
  'update:sideModel': [value: SecuritySide];
  'update:dateModel': [value: string];
  'update:quantityModel': [value: string];
  'update:tradeAmountModel': [value: string];
  selectMaster: [master: { id: string }];
  clear: [];
  securityTypeChange: [value: SecurityType];
}>();

/** 字段模型代理：props 只读，写操作经事件回传门面（vee-validate v-model 语义不变） */
const sideProxy = computed({
  get: () => props.sideModel,
  set: (value: SecuritySide) => emit('update:sideModel', value),
});
const dateProxy = computed({
  get: () => props.dateModel,
  set: (value: string) => emit('update:dateModel', value),
});
const tradeAmountProxy = computed({
  get: () => props.tradeAmountModel,
  set: (value: string) => emit('update:tradeAmountModel', value),
});

/**
 * 当前选中标的的展示文本(编辑态回显,INC-02 保底语义):
 * - 列表已到且含当前标的 → 名称(代码)
 * - resolve 缓存的选中元数据命中 → 名称(代码)（标的不在组合字典也能正常显示）
 * - 列表未到 → 当前标的(加载中…)
 * - 列表已到但当前标的不在 → 当前标的(已不在可选列表)
 */
const selectedSecurityLabel = computed(() => {
  if (!props.selectedSecurityId) return '';
  const found = (props.securities ?? []).find(
    (s) => s.id === props.selectedSecurityId,
  );
  if (found) return `${found.name}（${found.code}）`;
  if (props.resolvedSecurity?.id === props.selectedSecurityId) {
    return `${props.resolvedSecurity.name}（${props.resolvedSecurity.code}）`;
  }
  return props.secLoading || props.secDetailLoading
    ? '当前标的（加载中…）'
    : '当前标的（已不在可选列表）';
});

/** 选中系统主数据 → 上抛门面 resolve 懒实例化(ADR-003) */
function onSelectMaster(master: { id: string }): void {
  emit('selectMaster', master);
}
</script>

<template>
  <!-- 方向 -->
  <div class="space-y-2">
    <Label for="st-side">方向 *</Label>
    <Select v-model="sideProxy">
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
      v-model="dateProxy"
      v-bind="dateAttrs"
      type="date"
      :max="maxDate"
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
      @select="onSelectMaster"
      @clear="$emit('clear')"
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
      @update:model-value="(v: string) => emit('securityTypeChange', v as SecurityType)"
      :disabled="!selectedSecurityId || updateSecurityPending"
    >
      <SelectTrigger id="st-security-type">
        <SelectValue
          :placeholder="
            selectedSecurityId
              ? secLoading || secDetailLoading
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
      :model-value="quantityModel"
      @update:model-value="(v: unknown) => emit('update:quantityModel', v as string)"
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
      v-model="tradeAmountProxy"
      v-bind="tradeAmountAttrs"
      type="text"
      inputmode="decimal"
      placeholder="0.00"
    />
    <p v-if="errors.tradeAmount" class="text-xs text-destructive">
      {{ errors.tradeAmount }}
    </p>
  </div>
</template>
