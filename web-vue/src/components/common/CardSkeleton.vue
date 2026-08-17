<script setup lang="ts">
/**
 * components/common/CardSkeleton.vue — 卡片骨架屏
 */
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: string }>();
</script>

<template>
  <div :class="cn('space-y-4 rounded-lg border p-6', props.class)">
    <Skeleton class="h-4 w-1/3" />
    <Skeleton class="h-8 w-2/3" />
    <Skeleton class="h-3 w-1/2" />
  </div>
</template>
