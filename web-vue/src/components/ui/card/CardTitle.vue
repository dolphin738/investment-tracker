<script setup lang="ts">
/**
 * ui/card/CardTitle — 卡片标题（类名与 React 版一致）
 */
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: string }>();
</script>

<template>
  <h3 :class="cn('text-lg font-semibold leading-none tracking-tight', props.class)">
    <slot />
  </h3>
</template>
