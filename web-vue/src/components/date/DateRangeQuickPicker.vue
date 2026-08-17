<script setup lang="ts">
/**
 * components/date/DateRangeQuickPicker.vue — 日期范围 + 快捷范围选择器
 *
 * 平移自 React 版 web/src/components/date/date-range-quick-picker.tsx。
 *
 * 【定位（INC-01 决策 G）】全站唯一的日期区间控件。「快捷范围下拉 + 起止日期
 * 输入」这一组合只此一份实现，概览页 / 持仓页 / 出入金页 / 资产记录页 /
 * 现金余额变更历史 / 净值分析页 / XIRR 分析页全部复用，禁止内嵌第二套。
 *
 * 【受控】startDate / endDate 由父级持有；任何变更都通过 change 事件回传。
 * 快捷范围下拉支持双模：传 quick = 受控（父级驱动回显）；不传 = 沿用内部
 * 状态（历史调用方兼容路径）。
 *
 * 【交互契约】
 * - 选中快捷项 → 按 resolveQuickRange(v, { allRangeStart }) 覆盖起止日期，
 *   回调携带 quick 便于父级写 URL / 状态。
 * - 手动改起止日期 → 回调 quick 为 undefined，同时下拉回落占位。
 * - 「全部」起始日 = allRangeStart（组合首个交易日 baseDate），缺省回落
 *   ALL_RANGE_FALLBACK_START。
 *
 * 【文案（INC-01 设计稿拍板 3）】起止标签统一为「开始日期 / 结束日期」。
 */
import { computed, ref } from 'vue';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  QUICK_RANGE_OPTIONS,
  QUICK_RANGE_PLACEHOLDER,
  isQuickRangeValue,
  resolveQuickRange,
  type QuickRangeOption,
} from '@/modules/query/quick-range';
import { cn } from '@/lib/utils';

/** 起止日期标签（INC-01 拍板：全站统一「开始 / 结束」；SFC 内不导出） */
const RANGE_START_LABEL = '开始日期';
const RANGE_END_LABEL = '结束日期';

const props = withDefaults(
  defineProps<{
    /** 起始日期 YYYY-MM-DD（受控，空串 = 不限） */
    startDate: string;
    /** 结束日期 YYYY-MM-DD（受控，空串 = 不限） */
    endDate: string;
    /** 「全部」的起始日 —— 传组合首个交易日；缺省 / null 回落 2000-01-01 */
    allRangeStart?: string | null;
    /** 快捷范围选项（缺省 = 共享的 7 项 QUICK_RANGE_OPTIONS） */
    quickRanges?: ReadonlyArray<QuickRangeOption>;
    /**
     * 起始日期输入的 label。
     * @deprecated INC-01 已统一为「开始日期」，新代码不要传此 prop。
     */
    startLabel?: string;
    /**
     * 结束日期输入的 label。
     * @deprecated INC-01 已统一为「结束日期」，新代码不要传此 prop。
     */
    endLabel?: string;
    class?: string;
    /**
     * 受控的快捷范围值（如 '1m' / 'all'）。
     *
     * - 传入时：下拉回显完全由父级驱动（受控），内部 state 不再参与；
     *   传入不在 quickRanges 中的值（如 '' / 'custom'）→ 渲染占位「选择范围」。
     * - 不传（undefined）时：维持内部状态行为（遗留兼容模式）。
     */
    quick?: string;
  }>(),
  {
    allRangeStart: null,
    quickRanges: () => QUICK_RANGE_OPTIONS,
    startLabel: RANGE_START_LABEL,
    endLabel: RANGE_END_LABEL,
    quick: undefined,
  },
);

/** change 事件回传的区间 */
interface DateRangeValue {
  /** 起始日期 YYYY-MM-DD（空串 = 不限） */
  startDate: string;
  /** 结束日期 YYYY-MM-DD（空串 = 不限） */
  endDate: string;
  /**
   * 本次变更命中的快捷项 value（如 '1m' / 'all'）。
   * 手动编辑起止日期时为 undefined，父级可据此清除 URL 上的 range 参数。
   */
  quick?: string;
}

const emit = defineEmits<{
  change: [range: DateRangeValue];
}>();

// 下拉回显值（非受控模式）：选中预设后显示该预设；手动改日期后回落占位
const innerQuick = ref<string>(QUICK_RANGE_PLACEHOLDER);

/** 受控判定：quick 显式传入（含空串）即视为受控 */
const isControlled = computed(() => props.quick !== undefined);

/**
 * 实际回显值。
 * 受控：父级值命中 quickRanges 才回显，否则（如 '' / 'custom' / 未知值）落占位。
 * 非受控：用内部状态，逐字节保持改造前行为。
 */
const shownQuick = computed(() =>
  !isControlled.value
    ? innerQuick.value
    : isQuickRangeValue(props.quick, props.quickRanges)
      ? (props.quick as string)
      : QUICK_RANGE_PLACEHOLDER,
);

/** 选中快捷项：一次性覆盖起止日期 */
function handleQuickChange(v: string): void {
  // 受控模式下回显由父级 quick 驱动，内部 state 不再参与（避免双源）
  if (!isControlled.value) innerQuick.value = v;
  const range = resolveQuickRange(v, {
    allRangeStart: props.allRangeStart ?? undefined,
  });
  emit('change', {
    startDate: range.startDate,
    endDate: range.endDate,
    quick: v,
  });
}

/** 手动改起始日：下拉回落占位，quick 置空（Input 的 model 为 string | number，此处收窄为字符串） */
function handleStartChange(v: string | number): void {
  const startDate = String(v);
  if (!isControlled.value) innerQuick.value = QUICK_RANGE_PLACEHOLDER;
  emit('change', { startDate, endDate: props.endDate, quick: undefined });
}

/** 手动改结束日：下拉回落占位，quick 置空（Input 的 model 为 string | number，此处收窄为字符串） */
function handleEndChange(v: string | number): void {
  const endDate = String(v);
  if (!isControlled.value) innerQuick.value = QUICK_RANGE_PLACEHOLDER;
  emit('change', { startDate: props.startDate, endDate, quick: undefined });
}
</script>

<template>
  <div :class="cn('flex flex-wrap items-end gap-3', props.class)">
    <div v-if="props.quickRanges.length > 0" class="space-y-1.5">
      <Label class="text-xs text-muted-foreground">快捷范围</Label>
      <Select
        :model-value="shownQuick"
        @update:model-value="handleQuickChange"
      >
        <SelectTrigger class="w-[130px]">
          <SelectValue placeholder="选择范围" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            v-for="opt in props.quickRanges"
            :key="opt.value"
            :value="opt.value"
          >
            {{ opt.label }}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>

    <div class="space-y-1.5">
      <Label class="text-xs text-muted-foreground">{{ props.startLabel }}</Label>
      <Input
        type="date"
        :model-value="props.startDate"
        class="w-[150px]"
        @update:model-value="handleStartChange"
      />
    </div>

    <div class="space-y-1.5">
      <Label class="text-xs text-muted-foreground">{{ props.endLabel }}</Label>
      <Input
        type="date"
        :model-value="props.endDate"
        class="w-[150px]"
        @update:model-value="handleEndChange"
      />
    </div>
  </div>
</template>
