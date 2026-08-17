<script setup lang="ts">
/**
 * ui/section/Section — 页面纵向分区骨架（纯展示，无状态）
 *
 * 与 React 版一致：小标题 + 可选描述 + 可选右上角操作位（action 插槽），
 * 只用留白与字号建立层次，不画分隔线、不加背景块；仅使用语义色，
 * 深浅色主题自动适配。
 */
import { cn } from '@/lib/utils';

const props = defineProps<{
  /** 区块标题（如「关键指标」「趋势分析」） */
  title: string;
  /** 区块描述，缺省不渲染 */
  description?: string;
  class?: string;
}>();
</script>

<template>
  <section :class="cn('space-y-4', props.class)">
    <div class="flex items-end justify-between gap-3">
      <div class="space-y-1">
        <h2 class="text-base font-semibold">{{ title }}</h2>
        <p v-if="description" class="text-sm text-muted-foreground">
          {{ description }}
        </p>
      </div>
      <slot name="action" />
    </div>
    <div class="space-y-4">
      <slot />
    </div>
  </section>
</template>
