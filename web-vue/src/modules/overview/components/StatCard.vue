<script setup lang="ts">
/**
 * modules/overview/components/StatCard.vue — 指标卡片组件
 *
 * 平移自 React 版 web/src/components/charts/stat-card.tsx。
 * 用于概览页「关键指标」区：资产构成 4 卡 + 收益表现 4 卡。
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
  title: string;
  value: string;
  /** 较前值变化（已格式化字符串，如 "+2.1pp"），可选 */
  change?: string;
  /** 变化方向，决定图标颜色（PRD §9.5: 正红负绿） */
  trend?: 'up' | 'down' | 'neutral';
  /** 数值颜色覆盖（用于负值显示红色等） */
  valueClassName?: string;
  /** 辅助描述 */
  description?: string;
  class?: string;
}>();

const trend = computed(() => props.trend ?? 'neutral');

const trendColor = computed(() =>
  trend.value === 'up'
    ? 'text-up'
    : trend.value === 'down'
      ? 'text-down'
      : 'text-muted-foreground',
);
</script>

<template>
  <Card :class="cn('overflow-hidden', props.class)">
    <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
      <CardTitle class="text-sm font-medium text-muted-foreground">
        {{ title }}
      </CardTitle>
      <ArrowUp v-if="trend === 'up'" :class="cn('h-4 w-4', trendColor)" />
      <ArrowDown v-else-if="trend === 'down'" :class="cn('h-4 w-4', trendColor)" />
    </CardHeader>
    <CardContent>
      <div :class="cn('text-2xl font-bold tabular-nums', props.valueClassName)">
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
