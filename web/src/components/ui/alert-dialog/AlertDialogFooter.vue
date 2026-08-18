<script setup lang="ts">
/**
 * ui/alert-dialog/AlertDialogFooter — 确认对话框底部按钮容器
 */
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: string }>();
</script>

<template>
  <div
    :class="cn(
      'flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2',
      props.class,
    )"
  >
    <slot />
  </div>
</template>
