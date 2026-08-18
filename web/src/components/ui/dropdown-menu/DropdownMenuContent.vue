<script setup lang="ts">
/**
 * ui/dropdown-menu/DropdownMenuContent — 菜单内容面板（基于 reka-ui DropdownMenu）
 *
 * React 版因缺 radix 依赖用 Popover 模拟（点击后 dispatch Escape 关闭），
 * Vue 版 reka-ui 自带完整 DropdownMenu，无需该 hack，类名保持一致。
 */
import { DropdownMenuContent, DropdownMenuPortal } from 'reka-ui';
import { cn } from '@/lib/utils';

const props = withDefaults(
  defineProps<{
    class?: string;
    sideOffset?: number;
  }>(),
  { sideOffset: 4 },
);
</script>

<template>
  <DropdownMenuPortal>
    <DropdownMenuContent
      :side-offset="props.sideOffset"
      :class="cn(
        'z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        'data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2',
        props.class,
      )"
    >
      <slot />
    </DropdownMenuContent>
  </DropdownMenuPortal>
</template>
