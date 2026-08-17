<script setup lang="ts">
/**
 * ui/select/SelectSeparator — 分隔线
 */
import { SelectSeparator } from 'reka-ui';
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: string }>();
</script>

<template>
  <SelectSeparator :class="cn('-mx-1 my-1 h-px bg-muted', props.class)" />
</template>
