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
    // —— 遗留 #1 根治：pool / 超时配置 ——
    // 1) QA 实测 vitest 默认 threads 池跑页面级测试会 OOM 崩溃，
    //    改用 forks 池（每文件独立子进程，内存隔离更好）规避崩溃。
    // 2) singleFork: true —— 全量在单一 fork 内串行执行。
    //    本地实测「forks 单进程」才稳定；串行可彻底消除跨文件并发争用，
    //    配合 api-client.test.ts 改为「微任务驱动完成（去真实定时器）」，
    //    根治 3 个用例在全量并发下的偶发 5s 超时抖动。
    //    高内存 CI 可改为 singleFork:false + 适度 maxForks 以提升并行度。
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // 适度提高超时（非掩盖：api-client 已不依赖定时器；此处仅作并发/CI 环境兜底）
    testTimeout: 10000,
  },
});
