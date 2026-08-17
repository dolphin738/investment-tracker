<script setup lang="ts">
/**
 * ui/dropdown-menu/DropdownMenuItem — 菜单项（选中后默认自动关闭菜单）
 */
import { DropdownMenuItem } from 'reka-ui';
import { cn } from '@/lib/utils';

const props = withDefaults(
  defineProps<{
    /** 左缩进样式（与 shadcn inset 变体一致） */
    inset?: boolean;
    class?: string;
    disabled?: boolean;
  }>(),
  { inset: false },
);
</script>

<template>
  <DropdownMenuItem
    :disabled="props.disabled"
    :class="cn(
      'relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      props.inset && 'pl-8',
      props.class,
    )"
  >
    <slot />
  </DropdownMenuItem>
</template>
