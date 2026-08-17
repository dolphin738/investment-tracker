<script setup lang="ts">
/**
 * ui/dialog/DialogDescription — 对话框描述文字
 */
import { DialogDescription } from 'reka-ui';
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: string }>();
</script>

<template>
  <DialogDescription :class="cn('text-sm text-muted-foreground', props.class)">
    <slot />
  </DialogDescription>
</template>
