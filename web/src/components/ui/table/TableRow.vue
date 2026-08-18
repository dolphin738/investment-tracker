<script setup lang="ts">
/**
 * ui/table/TableRow — 表格行（tr）
 */
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: string }>();
</script>

<template>
  <tr
    :class="cn(
      'border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted',
      props.class,
    )"
  >
    <slot />
  </tr>
</template>
