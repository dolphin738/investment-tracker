<script setup lang="ts">
/**
 * components/common/TableSkeleton.vue — 表格骨架屏
 */
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const props = withDefaults(
  defineProps<{
    /** 数据行数 */
    rows?: number;
    /** 列数 */
    cols?: number;
    class?: string;
  }>(),
  { rows: 5, cols: 4 },
);

/** 生成 [0, 1, ..., n-1] 序号数组供 v-for 渲染 */
function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}
</script>

<template>
  <div :class="cn('space-y-3', props.class)">
    <!-- 表头 -->
    <div class="flex gap-4 border-b pb-2">
      <Skeleton v-for="i in range(props.cols)" :key="`h-${i}`" class="h-4 flex-1" />
    </div>
    <!-- 数据行 -->
    <div v-for="r in range(props.rows)" :key="`r-${r}`" class="flex gap-4 py-2">
      <Skeleton v-for="c in range(props.cols)" :key="`c-${c}`" class="h-5 flex-1" />
    </div>
  </div>
</template>
