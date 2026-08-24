import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import path from 'path';

// Vitest 配置：jsdom 环境 + @ 别名 + Vue SFC 支持（平移纯逻辑单测用）
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.ts'],
    // 本机 jsdom 环境初始化极慢（单文件 environment 就近 20s），并且是 24 逻辑核，
    // vitest 默认会并发拉起近 23 个 worker 同时初始化 jsdom + 编译模块，
    // CPU 满载导致 api-client 等「首次动态 import 大依赖图」的用例冷启动偶发超 5s。
    // 两方面处理：① testTimeout 提到 30s 兜底；② maxWorkers 限制到 4，保证每个
    // worker 有足够 CPU，避免并发争用造成的假阳性（用例自身实际执行仅数百毫秒～数秒）。
    testTimeout: 30000,
    maxWorkers: 4,
    minWorkers: 2,
  },
});
