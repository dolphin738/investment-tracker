<script setup lang="ts">
/**
 * ui/card/CardFooter — 卡片底部（类名与 React 版一致）
 */
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: string }>();
</script>

<template>
  <div :class="cn('flex items-center p-6 pt-0', props.class)">
    <slot />
  </div>
</template>
