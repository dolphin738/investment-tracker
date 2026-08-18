<script setup lang="ts">
/**
 * ui/section/SectionTitle — 区块内的二级分组标题（弱化灰色小字）
 *
 * 用于在一个区块里再分组；是扫读锚点，不与卡片标题抢视觉权重。
 */
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: string }>();
</script>

<template>
  <h3 :class="cn('text-sm font-medium tracking-wide text-muted-foreground', props.class)">
    <slot />
  </h3>
</template>
