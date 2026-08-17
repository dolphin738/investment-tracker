<script setup lang="ts">
/**
 * ui/select/SelectTrigger — 下拉触发器（含右侧下箭头，类名与 React 版一致）
 */
import { SelectIcon, SelectTrigger } from 'reka-ui';
import { ChevronDown } from 'lucide-vue-next';
import { cn } from '@/lib/utils';

const props = defineProps<{
  class?: string;
  disabled?: boolean;
}>();
</script>

<template>
  <SelectTrigger
    :disabled="props.disabled"
    :class="cn(
      'flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1',
      props.class,
    )"
  >
    <slot />
    <SelectIcon>
      <ChevronDown class="h-4 w-4 opacity-50" />
    </SelectIcon>
  </SelectTrigger>
</template>
