<script setup lang="ts">
/**
 * ui/dropdown-menu/DropdownMenuSeparator — 菜单分隔线
 */
import { DropdownMenuSeparator } from 'reka-ui';
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: string }>();
</script>

<template>
  <DropdownMenuSeparator :class="cn('-mx-1 my-1 h-px bg-muted', props.class)" />
</template>
