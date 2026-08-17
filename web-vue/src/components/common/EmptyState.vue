<script setup lang="ts">
/**
 * components/common/EmptyState.vue — 空数据占位组件
 *
 * 用于列表/卡片无数据时的友好提示 + 引导操作。
 * icon / action 均为插槽（icon 放 lucide-vue-next 图标组件）。
 */
import { cn } from '@/lib/utils';

const props = defineProps<{
  /** 主标题 */
  title: string;
  /** 副描述 */
  description?: string;
  class?: string;
}>();
</script>

<template>
  <div
    :class="cn(
      'flex flex-col items-center justify-center py-16 text-center',
      props.class,
    )"
  >
    <div v-if="$slots.icon" class="mb-4 text-muted-foreground/60">
      <slot name="icon" />
    </div>
    <h3 class="text-lg font-medium text-muted-foreground">{{ title }}</h3>
    <p v-if="description" class="mt-2 max-w-sm text-sm text-muted-foreground/70">
      {{ description }}
    </p>
    <div v-if="$slots.action" class="mt-6">
      <slot name="action" />
    </div>
  </div>
</template>
