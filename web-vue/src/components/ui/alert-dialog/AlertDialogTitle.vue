<script setup lang="ts">
/**
 * ui/alert-dialog/AlertDialogTitle — 确认对话框标题
 */
import { AlertDialogTitle } from 'reka-ui';
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: string }>();
</script>

<template>
  <AlertDialogTitle :class="cn('text-lg font-semibold', props.class)">
    <slot />
  </AlertDialogTitle>
</template>
