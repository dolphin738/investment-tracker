<script setup lang="ts">
/**
 * ui/alert/AlertDescription — 提示条描述（类名与 React 版一致）
 */
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: string }>();
</script>

<template>
  <div :class="cn('text-sm [&_p]:leading-relaxed', props.class)">
    <slot />
  </div>
</template>
