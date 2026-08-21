/**
 * Vue 应用入口
 *
 * createApp + Pinia + Vue Query + Vue Router，挂载根组件。
 */

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { VueQueryPlugin } from '@tanstack/vue-query';
import App from './App.vue';
import router from './router';
import { reportClientError } from '@/lib/log-reporter';
import './index.css';

const rootElement = document.getElementById('app');

if (!rootElement) {
  throw new Error('Root element #app not found in the DOM');
}

const app = createApp(App);

// 全局错误捕获并上报到日志中心（方案 §4.2 / §7.2-2 / §7.3-2）：
// Vue 渲染/生命周期异常 + 未捕获 Promise + window error，统一经 log-reporter 节流上报。
function serializeErr(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

app.config.errorHandler = (err, _instance, info) => {
  reportClientError({
    level: 'error',
    module: 'vue',
    message: serializeErr(err),
    trace: err instanceof Error ? err.stack ?? null : null,
    detail: { info },
  });
  // eslint-disable-next-line no-console
  console.error('[vue error]', err, info);
};

window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  const reason = event.reason;
  reportClientError({
    level: 'error',
    module: 'unhandledrejection',
    message: reason instanceof Error ? reason.message : serializeErr(reason),
    trace: reason instanceof Error ? reason.stack ?? null : null,
  });
});

window.addEventListener('error', (event: ErrorEvent) => {
  // 仅上报真实 JS 异常（event.error 存在）；资源加载错误（img/script 404）无 error 对象，
  // 噪音大且无堆栈，跳过。
  if (!event.error) return;
  reportClientError({
    level: 'error',
    module: 'window.error',
    message: event.message || serializeErr(event.error),
    trace: event.error?.stack ?? null,
  });
});

app.use(createPinia());
app.use(VueQueryPlugin, {
  queryClientConfig: {
    defaultOptions: {
      queries: {
        retry: 1,
        refetchOnWindowFocus: false,
        staleTime: 30 * 1000,
      },
    },
  },
});
app.use(router);
app.mount(rootElement);
