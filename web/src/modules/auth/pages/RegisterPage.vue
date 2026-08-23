<script setup lang="ts">
/**
 * modules/auth/pages/RegisterPage.vue — 注册页
 *
 * 自 React 版 web/src/pages/register.tsx 平移：渐变背景 + 卡片居中，
 * 顶部展示系统名「投资收益统计系统」（H2 术语统一）。
 */
import { APP_NAME } from '@/lib/constants';
import RegisterForm from '../components/RegisterForm.vue';
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-gradient-to-br from-background to-muted p-4">
    <div class="w-full max-w-md">
      <p class="mb-2 text-center text-sm font-medium text-muted-foreground">{{ APP_NAME }}</p>
      <h1 class="mb-6 text-center text-2xl font-bold tracking-tight">注册</h1>
      <RegisterForm />
    </div>
  </div>
</template>
