/**
 * Vitest 配置（QA 补充）
 *
 * 与 vite.config.ts 分开，避免测试配置影响生产构建。
 * 别名需与 vite.config.ts 保持一致，否则 `@/lib/...` 解析不到。
 */

import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared/src'),
      '@investment-tracker/shared': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  test: {
    // 需要 FormData / localStorage / window.location
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    globals: false,
  },
});
