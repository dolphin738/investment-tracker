<script setup lang="ts">
/**
 * modules/analysis/components/DimensionSwitcher.vue — 维度切换 + 聚合方式（+ 内嵌统一日期范围控件）
 *
 * 平移自 React 版 web/src/features/query/dimension-switcher.tsx 组件部分
 * （类型与 toDimensionQueryParams 纯函数见 ../features/dimension.ts）。
 *
 * 用于 XIRR 分析页、净值分析页：
 * - Tabs 切换 granularity（日/周/月/年）
 * - 聚合方式切换（期末值/平均值）
 * - 日期范围：内嵌全站唯一控件 DateRangeQuickPicker（INC-01 决策 G），
 *   快捷项回显受控：modelValue.quick 由父页面持有，配合
 *   useRangePreferenceSync 完成偏好默认值对齐（决策 E）。
 *
 * 受控组件：v-model 持有 DimensionSwitcherValue，由父页面持有状态。
 */

import { computed } from 'vue';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import DateRangeQuickPicker from '@/components/date/DateRangeQuickPicker.vue';
import { QUICK_RANGE_OPTIONS } from '@/modules/query/quick-range';
import type { QuickRangeOption } from '@/modules/query/quick-range';
import { AGGREGATION_OPTIONS, GRANULARITY_OPTIONS } from '@/lib/constants';
import { cn } from '@/lib/utils';
import type {
  AggregationMethod,
  QueryGranularity,
} from '@/lib/types';
import type { DimensionSwitcherValue } from '../features/dimension';

const props = withDefaults(
  defineProps<{
    /** 受控值（v-model） */
    modelValue: DimensionSwitcherValue;
    /** 是否显示聚合方式切换（默认 true） */
    showAggregation?: boolean;
    /**
     * 快捷范围预设（如 近3月/近1年/今年/全部）。
     * 缺省 = 共享的 7 项 QUICK_RANGE_OPTIONS；传 [] 可隐藏快捷下拉。
     */
    quickRanges?: ReadonlyArray<QuickRangeOption>;
    /**
     * 「全部」快捷项的起始日 —— 传当前组合首个交易日（Portfolio.baseDate）。
     * 缺省或为 null 时回落 ALL_RANGE_FALLBACK_START。
     */
    allRangeStart?: string | null;
    class?: string;
  }>(),
  {
    showAggregation: true,
    quickRanges: () => QUICK_RANGE_OPTIONS,
    allRangeStart: null,
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: DimensionSwitcherValue];
}>();

/** 维度 Tabs 的 v-model 适配（写入走 update:modelValue，父页面持有状态） */
const granularityModel = computed<string>({
  get: () => props.modelValue.granularity,
  set: (v) =>
    emit('update:modelValue', {
      ...props.modelValue,
      granularity: v as QueryGranularity,
    }),
});

/** 聚合方式 Select 的 v-model 适配 */
const aggregationModel = computed<string>({
  get: () => props.modelValue.aggregation,
  set: (v) =>
    emit('update:modelValue', {
      ...props.modelValue,
      aggregation: v as AggregationMethod,
    }),
});

/**
 * 日期范围变更：手动改起止日期时 range.quick 为 undefined → 落回空串
 * （自定义区间不再高亮任何预设）。
 */
function handleRangeChange(range: {
  startDate: string;
  endDate: string;
  quick?: string;
}): void {
  emit('update:modelValue', {
    ...props.modelValue,
    startDate: range.startDate,
    endDate: range.endDate,
    quick: range.quick ?? '',
  });
}
</script>

<template>
  <div
    :class="cn(
      'flex flex-col gap-3 md:flex-row md:items-end md:justify-between',
      props.class,
    )"
  >
    <div class="flex items-end gap-3">
      <div class="space-y-1.5">
        <Label class="text-xs text-muted-foreground">维度</Label>
        <Tabs v-model="granularityModel">
          <TabsList>
            <TabsTrigger
              v-for="opt in GRANULARITY_OPTIONS"
              :key="opt.value"
              :value="opt.value"
            >
              {{ opt.label }}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div v-if="props.showAggregation" class="space-y-1.5">
        <Label class="text-xs text-muted-foreground">聚合方式</Label>
        <Select v-model="aggregationModel">
          <SelectTrigger class="w-[120px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              v-for="opt in AGGREGATION_OPTIONS"
              :key="opt.value"
              :value="opt.value"
            >
              {{ opt.label }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>

    <!-- 日期范围：全站唯一控件（INC-01 决策 G），受控 quick 回显 -->
    <DateRangeQuickPicker
      :quick="props.modelValue.quick ?? ''"
      :start-date="props.modelValue.startDate ?? ''"
      :end-date="props.modelValue.endDate ?? ''"
      :quick-ranges="props.quickRanges"
      :all-range-start="props.allRangeStart"
      @change="handleRangeChange"
    />
  </div>
</template>
