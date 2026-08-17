<script setup lang="ts">
/**
 * ui/select/SelectValue — 选中值展示（透传 reka-ui SelectValue）
 */
import { SelectValue } from 'reka-ui';

withDefaults(defineProps<{ placeholder?: string }>(), { placeholder: '' });
</script>

<template>
  <SelectValue :placeholder="placeholder">
    <slot />
  </SelectValue>
</template>
