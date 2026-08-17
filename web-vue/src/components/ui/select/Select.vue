<script setup lang="ts">
/**
 * ui/select/Select — 下拉选择根组件（基于 reka-ui SelectRoot）
 *
 * v-model 绑定当前选中项的 value。
 */
import { SelectRoot } from 'reka-ui';

const model = defineModel<string>({ default: '' });
</script>

<template>
  <SelectRoot v-model="model">
    <slot />
  </SelectRoot>
</template>
