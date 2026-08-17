import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';

// Vite 配置：Vue 3 + Tailwind 3 + shadcn-vue
// 开发代理 /api → http://localhost:3000（与 React 版后端一致）
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // 端口 5174，避免与 React 版 web/（5173）同时开发时冲突
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
