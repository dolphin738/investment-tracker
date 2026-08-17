<script setup lang="ts">
/**
 * ui/skeleton — 占位骨架屏（类名与 React 版一致）
 */
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: string }>();
</script>

<template>
  <div :class="cn('animate-pulse rounded-md bg-muted', props.class)" />
</template>
