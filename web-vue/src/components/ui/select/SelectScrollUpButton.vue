<script setup lang="ts">
/**
 * ui/select/SelectScrollUpButton — 向上滚动按钮
 */
import { SelectScrollUpButton } from 'reka-ui';
import { ChevronUp } from 'lucide-vue-next';
</script>

<template>
  <SelectScrollUpButton class="flex cursor-default items-center justify-center py-1">
    <ChevronUp class="h-4 w-4" />
  </SelectScrollUpButton>
</template>
