<script setup lang="ts">
/**
 * components/common/PageSkeleton.vue — 页面级骨架屏（概览页等）
 */
import { Skeleton } from '@/components/ui/skeleton';
import CardSkeleton from './CardSkeleton.vue';

/** 生成 [0, 1, ..., n-1] 序号数组供 v-for 渲染 */
function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}
</script>

<template>
  <div class="space-y-6">
    <!-- 页头 -->
    <div class="flex items-center justify-between">
      <div class="space-y-2">
        <Skeleton class="h-7 w-40" />
        <Skeleton class="h-4 w-60" />
      </div>
      <div class="flex gap-2">
        <Skeleton class="h-9 w-24" />
        <Skeleton class="h-9 w-24" />
      </div>
    </div>
    <!-- 指标卡 -->
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <CardSkeleton v-for="i in range(4)" :key="i" />
    </div>
    <!-- 图表 -->
    <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Skeleton class="h-80 w-full rounded-lg" />
      <Skeleton class="h-80 w-full rounded-lg" />
    </div>
  </div>
</template>
