<script setup lang="ts">
/**
 * ui/card/CardContent — 卡片内容区（类名与 React 版一致）
 */
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: string }>();
</script>

<template>
  <div :class="cn('p-6 pt-0', props.class)">
    <slot />
  </div>
</template>
