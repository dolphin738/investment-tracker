<script setup lang="ts">
/**
 * components/common/PageHeader.vue — 页面标题栏
 *
 * 统一页面标题 + 副描述 + 右侧操作区（actions 插槽）布局。
 */
import { cn } from '@/lib/utils';

const props = defineProps<{
  /** 页面标题 */
  title: string;
  /** 副描述 */
  description?: string;
  class?: string;
}>();
</script>

<template>
  <div :class="cn('flex flex-wrap items-center justify-between gap-3', props.class)">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">{{ title }}</h1>
      <p v-if="description" class="text-sm text-muted-foreground">
        {{ description }}
      </p>
    </div>
    <div v-if="$slots.actions" class="flex gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
