<script setup lang="ts">
/**
 * ui/alert-dialog/AlertDialogHeader — 确认对话框头部容器
 */
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: string }>();
</script>

<template>
  <div :class="cn('flex flex-col space-y-2 text-center sm:text-left', props.class)">
    <slot />
  </div>
</template>
