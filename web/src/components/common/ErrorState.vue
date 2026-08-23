<script setup lang="ts">
/**
 * components/common/ErrorState.vue — 统一错误状态块
 *
 * 收敛散落在各页的「数据加载失败」裸块（AlertTriangle + 文字），统一
 * 图标 / 文案层级 / 可选重试操作（#action 插槽），提升一致性与可访问性。
 */
import { AlertTriangle } from 'lucide-vue-next';
import { cn } from '@/lib/utils';

const props = defineProps<{
  /** 错误标题 */
  title?: string;
  /** 错误描述 */
  description?: string;
  class?: string;
}>();
</script>

<template>
  <div
    :class="
      cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-destructive/40 bg-destructive/5 px-4 py-8 text-center',
        props.class,
      )
    "
    role="alert"
    aria-live="assertive"
  >
    <AlertTriangle class="h-8 w-8 text-destructive" aria-hidden="true" />
    <p class="text-sm font-medium text-destructive">
      {{ props.title ?? '数据加载失败' }}
    </p>
    <p v-if="props.description" class="max-w-sm text-xs text-muted-foreground">
      {{ props.description }}
    </p>
    <slot name="action" />
  </div>
</template>
