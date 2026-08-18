<script setup lang="ts">
/**
 * ui/tabs/TabsContent — 页签内容面板（value 对应 TabsTrigger 的 value）
 */
import { TabsContent } from 'reka-ui';
import { cn } from '@/lib/utils';

const props = defineProps<{
  value: string;
  class?: string;
}>();
</script>

<template>
  <TabsContent
    :value="props.value"
    :class="cn(
      'mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      props.class,
    )"
  >
    <slot />
  </TabsContent>
</template>
