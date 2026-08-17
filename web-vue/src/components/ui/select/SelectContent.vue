<script setup lang="ts">
/**
 * ui/select/SelectContent — 下拉内容面板（内置 Portal + 滚动按钮 + Viewport）
 *
 * reka-ui 的 CSS 变量前缀为 --reka-（对应 radix 的 --radix-）。
 */
import { SelectContent, SelectPortal, SelectViewport } from 'reka-ui';
import { cn } from '@/lib/utils';
import SelectScrollUpButton from './SelectScrollUpButton.vue';
import SelectScrollDownButton from './SelectScrollDownButton.vue';

const props = withDefaults(
  defineProps<{
    class?: string;
    position?: 'item-aligned' | 'popper';
  }>(),
  { position: 'popper' },
);
</script>

<template>
  <SelectPortal>
    <SelectContent
      :position="props.position"
      :class="cn(
        'relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        props.position === 'popper' &&
          'data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1',
        props.class,
      )"
    >
      <SelectScrollUpButton />
      <SelectViewport
        :class="cn(
          'p-1',
          props.position === 'popper' &&
            'h-[var(--reka-select-trigger-height)] w-full min-w-[var(--reka-select-trigger-width)]',
        )"
      >
        <slot />
      </SelectViewport>
      <SelectScrollDownButton />
    </SelectContent>
  </SelectPortal>
</template>
