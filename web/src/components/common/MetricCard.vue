<script setup lang="ts">
/**
 * components/common/MetricCard.vue — 统一指标卡片
 *
 * 收敛三套分裂的「指标卡片」范式（StatCard / analysis 页 CardTitle 放大承载数值 /
 * 持仓裸 div 聚合），统一文字层级与涨跌语义（PRD §9.5: 正红负绿）。
 *
 * 文字标尺（对齐 ui-design-review.md §5）：
 *   - hero 档：数值 text-3xl（页面级关键数字，如累计 XIRR）
 *   - metric 档：数值 text-2xl（区块级指标，如持仓汇总）
 *   - 标签：text-sm text-muted-foreground
 *   - 辅助说明：text-xs text-muted-foreground
 */
import { computed } from 'vue';
import { ArrowDown, ArrowUp } from 'lucide-vue-next';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';

const props = defineProps<{
  /** 指标标签 */
  label: string;
  /** 已格式化的数值字符串 */
  value: string;
  /** 尺寸档：hero=页面级关键数字(text-3xl) / metric=区块级指标(text-2xl) */
  size?: 'hero' | 'metric';
  /** 较前值变化（已格式化字符串，如 "+2.1pp"），可选 */
  change?: string;
  /** 变化方向，决定图标与颜色 */
  trend?: 'up' | 'down' | 'neutral';
  /** 数值颜色覆盖（用于负值显示红色等） */
  valueClassName?: string;
  /** 辅助描述 */
  description?: string;
  class?: string;
}>();

const size = computed(() => props.size ?? 'metric');

const trendColor = computed(() =>
  props.trend === 'up'
    ? 'text-up'
    : props.trend === 'down'
      ? 'text-down'
      : 'text-muted-foreground',
);

const valueSizeClass = computed(() =>
  size.value === 'hero' ? 'text-3xl' : 'text-2xl',
);
</script>

<template>
  <Card :class="cn('overflow-hidden', props.class)">
    <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
      <CardTitle class="text-sm font-medium text-muted-foreground">
        {{ label }}
      </CardTitle>
      <ArrowUp v-if="trend === 'up'" :class="cn('h-4 w-4', trendColor)" />
      <ArrowDown v-else-if="trend === 'down'" :class="cn('h-4 w-4', trendColor)" />
    </CardHeader>
    <CardContent>
      <div :class="cn('font-bold tabular-nums', valueSizeClass, props.valueClassName)">
        {{ value }}
      </div>
      <div
        v-if="props.change || props.description"
        class="mt-1 flex items-center text-xs"
      >
        <span v-if="props.change" :class="cn('font-medium', trendColor)">
          {{ props.change }}
        </span>
        <span
          v-if="props.change && props.description"
          class="mx-1 text-muted-foreground"
        >·</span>
        <span v-if="props.description" class="text-muted-foreground">
          {{ props.description }}
        </span>
      </div>
    </CardContent>
  </Card>
</template>
