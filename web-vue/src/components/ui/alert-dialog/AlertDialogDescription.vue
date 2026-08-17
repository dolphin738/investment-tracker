<script setup lang="ts">
/**
 * ui/alert-dialog/AlertDialogDescription — 确认对话框描述文字
 */
import { AlertDialogDescription } from 'reka-ui';
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: string }>();
</script>

<template>
  <AlertDialogDescription :class="cn('text-sm text-muted-foreground', props.class)">
    <slot />
  </AlertDialogDescription>
</template>
