<script setup lang="ts">
/**
 * ui/switch — 开关（基于 reka-ui SwitchRoot/SwitchThumb，类名与 React 版一致）
 *
 *   <Switch v-model="enabled" />
 *   <Switch :default-value="true" disabled />
 */
import { SwitchRoot, SwitchThumb } from 'reka-ui';
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: string }>();

const model = defineModel<boolean>({ default: false });
</script>

<template>
  <SwitchRoot
    v-model="model"
    :class="cn(
      'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'data-[state=checked]:bg-primary data-[state=unchecked]:bg-input',
      props.class,
    )"
  >
    <SwitchThumb
      :class="cn(
        'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
        'data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0',
      )"
    />
  </SwitchRoot>
</template>
