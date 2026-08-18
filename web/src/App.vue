<script setup lang="ts">
/**
 * App 根组件
 *
 * 集成 Vue Router 路由出口 + 主题管理 + Toaster。
 * 路由结构见 router/index.ts（对齐 ARCH §10.1.1）。
 */

import { RouterView } from 'vue-router';
import { Toaster } from 'vue-sonner';
import ThemeManager from '@/components/common/ThemeManager.vue';
</script>

<template>
  <ThemeManager />
  <RouterView />
  <Toaster
    position="top-center"
    rich-colors
    close-button
    :duration="3000"
  />
</template>
