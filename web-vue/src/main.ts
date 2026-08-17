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
import './index.css';

const rootElement = document.getElementById('app');

if (!rootElement) {
  throw new Error('Root element #app not found in the DOM');
}

const app = createApp(App);
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
