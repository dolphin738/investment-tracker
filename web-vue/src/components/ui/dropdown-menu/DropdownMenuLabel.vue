<script setup lang="ts">
/**
 * ui/dropdown-menu/DropdownMenuLabel — 菜单分组标签
 */
import { cn } from '@/lib/utils';

const props = withDefaults(
  defineProps<{
    inset?: boolean;
    class?: string;
  }>(),
  { inset: false },
);
</script>

<template>
  <div :class="cn('px-2 py-1.5 text-sm font-semibold', props.inset && 'pl-8', props.class)">
    <slot />
  </div>
</template>
