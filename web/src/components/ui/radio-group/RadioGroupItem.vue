<script setup lang="ts">
/**
 * ui/radio-group/RadioGroupItem — 单选项（原生 radio，外观对齐 shadcn/ui）
 *
 * 从父级 RadioGroup 注入当前值与禁用状态；选中态渲染主色外圈 + 内点。
 */
import { computed, inject, useId } from 'vue';
import { cn } from '@/lib/utils';
import { RADIO_GROUP_KEY } from './RadioGroup.vue';

const props = defineProps<{
  /** 该项的值 */
  value: string;
  /** 标签文本（默认插槽优先） */
  label?: string;
  disabled?: boolean;
  class?: string;
}>();

const group = inject(RADIO_GROUP_KEY, null);

const itemId = useId();
const isChecked = computed(() => group?.value.value === props.value);
const isDisabled = computed(() => group?.disabled.value === true || props.disabled === true);
</script>

<template>
  <label
    :for="itemId"
    :class="cn(
      'inline-flex items-center gap-2 text-sm font-medium leading-none',
      isDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
      props.class,
    )"
  >
    <span class="relative flex h-4 w-4 shrink-0 items-center justify-center">
      <input
        :id="itemId"
        type="radio"
        class="sr-only"
        :value="props.value"
        :checked="isChecked"
        :disabled="isDisabled"
        @change="group && (group.value.value = props.value)"
      />
      <!-- 外圈 -->
      <span
        :class="cn(
          'absolute inset-0 rounded-full border',
          isChecked ? 'border-primary' : 'border-muted-foreground/40',
        )"
      />
      <!-- 内点 -->
      <span v-if="isChecked" class="absolute inset-[3px] rounded-full bg-primary" />
    </span>
    <slot>
      <span v-if="label">{{ label }}</span>
    </slot>
  </label>
</template>
