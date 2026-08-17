<script setup lang="ts">
/**
 * ui/alert-dialog/AlertDialogCancel — 取消按钮（点击后关闭对话框）
 *
 * 样式复用 buttonVariants outline 变体，与 React 版一致。
 */
import { AlertDialogCancel } from 'reka-ui';
import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button';

const props = defineProps<{ class?: string }>();
</script>

<template>
  <AlertDialogCancel
    :class="cn(buttonVariants({ variant: 'outline' }), 'mt-2 sm:mt-0', props.class)"
  >
    <slot />
  </AlertDialogCancel>
</template>
