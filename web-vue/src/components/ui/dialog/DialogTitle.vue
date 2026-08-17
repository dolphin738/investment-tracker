<script setup lang="ts">
/**
 * ui/dialog/DialogTitle — 对话框标题
 */
import { DialogTitle } from 'reka-ui';
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: string }>();
</script>

<template>
  <DialogTitle
    :class="cn('text-lg font-semibold leading-none tracking-tight', props.class)"
  >
    <slot />
  </DialogTitle>
</template>
