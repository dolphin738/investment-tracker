<script setup lang="ts">
/**
 * ui/tabs/Tabs — 页签容器（基于 reka-ui TabsRoot）
 *
 * v-model 绑定当前激活页签的 value。
 */
import { TabsRoot } from 'reka-ui';

const model = defineModel<string>({ default: '' });
</script>

<template>
  <TabsRoot v-model="model">
    <slot />
  </TabsRoot>
</template>
