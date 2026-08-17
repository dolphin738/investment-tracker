<script setup lang="ts">
/**
 * ui/input — 文本输入框（类名与 React 版一致）
 *
 * 使用 defineModel 支持 v-model 双向绑定，
 * 其余原生属性（placeholder / disabled 等）经 attrs 透传到 input 元素。
 */
import { cn } from '@/lib/utils';

const props = defineProps<{
  type?: string;
  class?: string;
}>();

const model = defineModel<string | number>({ default: '' });
</script>

<template>
  <input
    v-model="model"
    :type="props.type ?? 'text'"
    :class="cn(
      'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
      props.class,
    )"
  />
</template>
