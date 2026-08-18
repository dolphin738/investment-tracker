<script setup lang="ts">
/**
 * ui/tabs/TabsTrigger — 页签触发器（value 对应 TabsContent 的 value）
 */
import { TabsTrigger } from 'reka-ui';
import { cn } from '@/lib/utils';

const props = defineProps<{
  value: string;
  class?: string;
  disabled?: boolean;
}>();
</script>

<template>
  <TabsTrigger
    :value="props.value"
    :disabled="props.disabled"
    :class="cn(
      'inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm',
      props.class,
    )"
  >
    <slot />
  </TabsTrigger>
</template>
