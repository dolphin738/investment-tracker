<script lang="ts">
/**
 * ui/radio-group/RadioGroup — 单选组容器（原生 radio + provide/inject）
 *
 * 与 React 版一致：原生 input[type=radio] 实现，外观对齐 shadcn/ui。
 * 通过 provide 将当前值与禁用状态下发给 RadioGroupItem。
 */

import type { InjectionKey, Ref } from 'vue';

/** 子项注入的上下文类型 */
export interface RadioGroupContext {
  /** 当前选中值（响应式） */
  value: Ref<string>;
  /** 组级禁用（响应式，跟随 props） */
  disabled: Ref<boolean>;
}

/** 注入键（Symbol 保证唯一；script setup 不允许命名导出，故置于普通 script 块） */
export const RADIO_GROUP_KEY: InjectionKey<RadioGroupContext> = Symbol('RadioGroup');
</script>

<script setup lang="ts">
import { provide, toRef } from 'vue';
import { cn } from '@/lib/utils';

const props = withDefaults(
  defineProps<{
    /** 排列方向 */
    orientation?: 'horizontal' | 'vertical';
    disabled?: boolean;
    class?: string;
  }>(),
  { orientation: 'vertical', disabled: false },
);

const model = defineModel<string>({ default: '' });

provide(RADIO_GROUP_KEY, {
  value: model,
  disabled: toRef(props, 'disabled'),
});
</script>

<template>
  <div
    role="radiogroup"
    :class="cn(
      orientation === 'horizontal' ? 'flex flex-wrap gap-4' : 'flex flex-col gap-2',
      props.class,
    )"
  >
    <slot />
  </div>
</template>
