import { createMemoryHistory, createRouter } from 'vue-router';
import type { Router } from 'vue-router';

/**
 * 认证表单测试用的内存路由（超集：覆盖 login / register 两测试曾逐份复制的路由表）。
 * 额外的 `/holdings` 路由永不被测试导航，属无害超集。
 */
export function buildRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/login', name: 'login', component: { template: '<div>login-page</div>' } },
      { path: '/register', name: 'register', component: { template: '<div>register-page</div>' } },
      { path: '/', name: 'dashboard', component: { template: '<div>dashboard-page</div>' } },
      { path: '/holdings', name: 'holdings', component: { template: '<div>holdings-page</div>' } },
    ],
  });
}
