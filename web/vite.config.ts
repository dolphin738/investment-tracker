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
  build: {
    // 体积告警阈值：默认 500KB 过严。拆分后剩余大块均为「共享 vendor」或
    // 「管理端按需懒加载块」（如 DynamicIcon 触发全量 lucide），加载一次且可缓存，
    // 设 850KB 仅对「页面级 chunk 异常膨胀」这类真问题报警。
    chunkSizeWarningLimit: 850,
    rollupOptions: {
      output: {
        /**
         * 按 node_modules 包粒度拆分重型 vendor，避免被页面 chunk 独占打包：
         * - 提升浏览器缓存命中（vendor 不随业务代码变更而失效）
         * - 缩减 AdminPage 等页面 chunk 体积（reka-ui / echarts 等不再内联进页面块）
         * 注意：lucide-vue-next 不在此处拆分——其全量命名空间仅由 DynamicIcon
         * 的动态 import 按需懒加载（管理端接口分类板块），应留在独立懒加载块而非常驻 vendor。
         * 注意用带斜杠的精确路径匹配，避免 `includes('vue')` 误伤 vue-router / vue-echarts 等。
         */
        manualChunks(id: string) {
          if (id.includes('node_modules')) {
            if (id.includes('echarts') || id.includes('zrender') || id.includes('vue-echarts'))
              return 'vendor-echarts';
            if (id.includes('reka-ui')) return 'vendor-reka';
            if (id.includes('@tanstack')) return 'vendor-vue-query';
            if (id.includes('vee-validate') || id.includes('zod') || id.includes('@vee')) return 'vendor-forms';
            if (id.includes('vue-draggable-plus')) return 'vendor-draggable';
            if (id.includes('vue-sonner')) return 'vendor-sonner';
            if (
              id.includes('/vue-router/') ||
              id.includes('/pinia/') ||
              id.includes('/vue/') ||
              id.includes('/axios/') ||
              id.includes('/clsx/') ||
              id.includes('/tailwind-merge/') ||
              id.includes('/class-variance-authority/')
            )
              return 'vendor-core';
          }
        },
      },
    },
  },
});
