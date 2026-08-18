<script setup lang="ts">
/**
 * ui/select/SelectScrollDownButton — 向下滚动按钮
 */
import { SelectScrollDownButton } from 'reka-ui';
import { ChevronDown } from 'lucide-vue-next';
</script>

<template>
  <SelectScrollDownButton class="flex cursor-default items-center justify-center py-1">
    <ChevronDown class="h-4 w-4" />
  </SelectScrollDownButton>
</template>
