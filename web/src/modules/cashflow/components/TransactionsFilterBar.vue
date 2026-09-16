<script setup lang="ts">
/**
 * modules/cashflow/components/TransactionsFilterBar.vue — 统一筛选器
 *
 * 平移自 TransactionsPage.vue 的「统一筛选器」卡片（纯位移，零行为变更）。
 * 纯展示组件：筛选状态（类型多选 / 快捷范围 / 排序 / 日期）由门面以 props 传入，
 * 交互通过 emit 回传门面既有处理函数（写 URL query 的逻辑留在门面）。
 * TRANSACTION_TYPE_OPTIONS / SORT_OPTIONS 为模块常量，本组件自行导入。
 */

import { RotateCcw } from 'lucide-vue-next';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import HelpTip from '@/components/common/HelpTip.vue';
import DateRangeQuickPicker from '@/components/date/DateRangeQuickPicker.vue';
import {
  parseTransactionSearchParams,
  SORT_OPTIONS,
  TRANSACTION_TYPE_OPTIONS,
  type TransactionTypeOption,
} from '../query-params';

/** 门面 parsed 计算属性的形状（URL query 解码结果，见 query-params.ts） */
type ParsedParams = ReturnType<typeof parseTransactionSearchParams>;

defineProps<{
  /** URL query 解码结果（类型多选 / 排序取自此对象） */
  parsed: ParsedParams;
  /** 快捷范围受控回显值（INC-01，URL range 为唯一真相源） */
  quickValue: string;
  /** 统一筛选器生效的起始日期 */
  filterStartDate: string;
  /** 统一筛选器生效的结束日期 */
  filterEndDate: string;
  /** 「全部」快捷项起点 = 组合首个交易日 */
  baseDate: string | null;
}>();
const emit = defineEmits<{
  /** 类型多选切换（直传门面 handleToggleType） */
  toggleType: [t: TransactionTypeOption];
  /** 日期范围变更（直传门面 handleRangeChange） */
  rangeChange: [r: { startDate: string; endDate: string; quick?: string }];
  /** 排序切换（直传门面 handleSortChange） */
  sortChange: [v: string];
  /** 重置全部筛选（直传门面 handleResetFilter） */
  resetFilter: [];
}>();
</script>

<template>
  <Card>
    <CardHeader class="pb-3">
      <CardTitle class="text-base">筛选</CardTitle>
      <div class="flex items-center gap-1.5 text-sm text-muted-foreground">
        <span>统一筛选器</span>
        <HelpTip text="日期范围对「出入金流水」与「现金余额」同时生效；类型与排序仅作用于出入金流水。">
          <template #content>
            <p>日期范围对「出入金流水」与「现金余额」同时生效。</p>
            <p class="mt-1">类型与排序仅作用于出入金流水。</p>
          </template>
        </HelpTip>
      </div>
    </CardHeader>
    <CardContent>
      <div class="flex flex-wrap items-end gap-3">
        <!--
          问题⑥：把「不勾选 = 全部」并入 Label，使「类型」这一列与其它列
          都是「Label + h-9 控件」的等高结构，items-end 下天然对齐。
        -->
        <div class="space-y-1.5">
          <Label class="text-xs">类型（不勾选 = 全部 · 仅流水）</Label>
          <div class="flex h-9 items-center gap-4 rounded-md border border-input px-3">
            <label
              v-for="t in TRANSACTION_TYPE_OPTIONS"
              :key="t"
              class="flex cursor-pointer items-center gap-1.5 text-sm"
            >
              <input
                type="checkbox"
                class="h-4 w-4 accent-primary"
                :checked="parsed.types.includes(t)"
                @change="emit('toggleType', t)"
              />
              <span :class="t === 'BUY' ? 'text-up' : 'text-down'">
                {{ t === 'BUY' ? '存入' : '取出' }}
              </span>
            </label>
          </div>
        </div>
        <!-- 问题⑤⑥：接入共享快捷范围控件，与资产记录页同一实现 -->
        <DateRangeQuickPicker
          :quick="quickValue"
          :start-date="filterStartDate"
          :end-date="filterEndDate"
          :all-range-start="baseDate"
          @change="emit('rangeChange', $event)"
        />
        <div class="space-y-1.5">
          <Label class="text-xs">排序（仅流水）</Label>
          <Select
            :model-value="`${parsed.sortBy}:${parsed.sortOrder}`"
            @update:model-value="emit('sortChange', $event)"
          >
            <SelectTrigger class="w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                v-for="opt in SORT_OPTIONS"
                :key="opt.value"
                :value="opt.value"
              >
                {{ opt.label }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="flex gap-2">
          <Button size="sm" variant="outline" @click="emit('resetFilter')">
            <RotateCcw class="mr-1 h-3.5 w-3.5" />
            重置
          </Button>
        </div>
      </div>
    </CardContent>
  </Card>
</template>
