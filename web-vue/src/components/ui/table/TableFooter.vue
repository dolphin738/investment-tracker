<script setup lang="ts">
/**
 * ui/table/TableFooter — 表尾分组（tfoot）
 */
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: string }>();
</script>

<template>
  <tfoot
    :class="cn(
      'border-t bg-muted/50 font-medium [&>tr]:last:border-b-0',
      props.class,
    )"
  >
    <slot />
  </tfoot>
</template>
