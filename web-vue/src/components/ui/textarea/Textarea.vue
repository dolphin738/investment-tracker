<script setup lang="ts">
/**
 * ui/textarea — 多行文本输入框（类名与 React 版一致）
 *
 * 使用 defineModel 支持 v-model 双向绑定，
 * 其余原生属性经 attrs 透传到 textarea 元素。
 */
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: string }>();

const model = defineModel<string>({ default: '' });
</script>

<template>
  <textarea
    v-model="model"
    :class="cn(
      'flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
      props.class,
    )"
  />
</template>
