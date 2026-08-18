<script setup lang="ts">
/**
 * components/common/LoadingSpinner.vue — 加载态组件
 *
 * 提供 Spinner（居中旋转图标）与文字提示，与 React 版一致。
 * 骨架屏类组件见同目录 CardSkeleton / TableSkeleton / PageSkeleton。
 */
import { Loader2 } from 'lucide-vue-next';
import { cn } from '@/lib/utils';

const props = withDefaults(
  defineProps<{
    /** 提示文字 */
    text?: string;
    /** 尺寸 */
    size?: 'sm' | 'md' | 'lg';
    class?: string;
  }>(),
  { size: 'md' },
);

const sizeMap: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'h-4 w-4',
  md: 'h-8 w-8',
  lg: 'h-12 w-12',
};
</script>

<template>
  <div
    :class="cn(
      'flex flex-col items-center justify-center py-16',
      props.class,
    )"
  >
    <Loader2 :class="cn('animate-spin text-muted-foreground', sizeMap[props.size])" />
    <p v-if="props.text" class="mt-3 text-sm text-muted-foreground">
      {{ props.text }}
    </p>
  </div>
</template>
