<script setup lang="ts">
/**
 * ui/alert-dialog/AlertDialogAction — 确认按钮（点击后关闭对话框）
 *
 * 样式复用 buttonVariants 默认变体，与 React 版一致。
 */
import { AlertDialogAction } from 'reka-ui';
import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button';

const props = defineProps<{ class?: string }>();
</script>

<template>
  <AlertDialogAction :class="cn(buttonVariants(), props.class)">
    <slot />
  </AlertDialogAction>
</template>
